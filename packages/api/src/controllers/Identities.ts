import { Controller, Get, Middleware, Post } from "@overnightjs/core";
import { IdentitySchemas, UtilitySchemas } from "@plunk/shared";
import type { Request, Response } from "express";
import signale from "signale";
import { prisma } from "../database/prisma";
import { NotFound } from "../exceptions";
import { type IJwt, isAuthenticated } from "../middleware/auth";
import { ProjectService } from "../services/ProjectService";
import { Keys } from "../services/keys";
import { redis } from "../services/redis";
import { mgClient } from "../services/mailgun";

@Controller("identities")
export class Identities {
	@Get("id/:id")
	@Middleware([isAuthenticated])
	public async getVerification(req: Request, res: Response) {
		const { id } = UtilitySchemas.id.parse(req.params);

		const project = await ProjectService.id(id);

		if (!project) {
			throw new NotFound("project");
		}

		if (!project.email) {
			return res.status(200).json({ success: false });
		}

		const attributes = await this.getIdentityVerificationAttributes(project.email);

		if (attributes.status === "Success" && !project.verified) {
			await prisma.project.update({ where: { id }, data: { verified: true } });

			await redis.del(Keys.Project.id(project.id));
			await redis.del(Keys.Project.secret(project.secret));
			await redis.del(Keys.Project.public(project.public));
		}

		return res.status(200).json({ tokens: attributes.tokens });
	}

	@Middleware([isAuthenticated])
	@Post("create")
	public async addIdentity(req: Request, res: Response) {
		const { id, email } = IdentitySchemas.create.parse(req.body);

		const { userId } = res.locals.auth as IJwt;

		const project = await ProjectService.id(id);

		if (!project) {
			throw new NotFound("project");
		}

		const existingProject = await prisma.project.findFirst({
			where: { email: { endsWith: email.split("@")[1] } },
		});

		if (existingProject) {
			throw new Error("Domain already attached to another project");
		}

		const tokens = await this.verifyIdentity(email);

		await prisma.project.update({
			where: { id },
			data: { email, verified: false },
		});

		await redis.del(Keys.User.projects(userId));
		await redis.del(Keys.Project.id(project.id));

		return res.status(200).json({ success: true, tokens });
	}

	@Middleware([isAuthenticated])
	@Post("reset")
	public async resetIdentity(req: Request, res: Response) {
		const { id } = UtilitySchemas.id.parse(req.body);

		const { userId } = res.locals.auth as IJwt;

		const project = await ProjectService.id(id);

		if (!project) {
			throw new NotFound("project");
		}

		await prisma.project.update({
			where: { id },
			data: { email: null, verified: false },
		});

		await redis.del(Keys.User.projects(userId));
		await redis.del(Keys.Project.id(project.id));

		return res.status(200).json({ success: true });
	}

	@Post("update")
	public async updateIdentities(req: Request, res: Response) {
		const count = await prisma.project.count({
			where: { email: { not: null } },
		});

		for (let i = 0; i < count; i += 99) {
			const dbIdentities = await prisma.project.findMany({
				where: { email: { not: null } },
				select: { id: true, email: true },
				skip: i,
				take: 99,
			});

			const mailgunIdentities = await this.getIdentities(dbIdentities.map((i) => i.email as string));

			for (const identity of mailgunIdentities) {
				const projectId = dbIdentities.find((i) => i.email?.endsWith(identity.email));

				const project = await ProjectService.id(projectId?.id as string);

				if (identity.status === "Failed") {
					signale.info(`Restarting verification for ${identity.email}`);
					try {
						void this.verifyIdentity(identity.email);
					} catch (e) {
						// Handle Mailgun rate limiting
						if ((e as any).status === 429) {
							signale.warn("Rate limiting detected, waiting 5 seconds");
							await new Promise((r) => setTimeout(r, 5000));
						}
					}
				}

				await prisma.project.update({
					where: { id: projectId?.id as string },
					data: { verified: identity.status === "Success" },
				});

				if (project && !project.verified && identity.status === "Success") {
					signale.success(`Successfully verified ${identity.email}`);

					await redis.del(Keys.Project.id(project.id));
					await redis.del(Keys.Project.secret(project.secret));
					await redis.del(Keys.Project.public(project.public));
				}

				if (project?.verified && identity.status !== "Success") {
					await redis.del(Keys.Project.id(project.id));
					await redis.del(Keys.Project.secret(project.secret));
					await redis.del(Keys.Project.public(project.public));
				}
			}
		}

		return res.status(200).json({ success: true });
	}

	// Mailgun helper methods
	private async getIdentities(identities: string[]): Promise<{ email: string; status: string }[]> {
		const domains = identities.map((identity) => identity.split("@")[1]);
		const results: { email: string; status: string }[] = [];

		for (const domain of domains) {
			try {
				const response = await mgClient.domains.get(domain);
				const domainInfo = response as any;
				
				// Map Mailgun status to SES-like status
				let status = "Failed";
				if (domainInfo.status === "active") {
					status = "Success";
				} else if (domainInfo.status === "unverified") {
					status = "PendingVerification";
				}

				results.push({ email: domain, status });
			} catch (error: any) {
				// Domain not found or other error, treat as failed
				signale.warn(`Failed to get domain info for ${domain}: ${error.message}`);
				results.push({ email: domain, status: "Failed" });
			}
		}

		return results;
	}

	private async verifyIdentity(email: string): Promise<string[]> {
		const domain = email.includes("@") ? email.split("@")[1] : email;

		try {
			// Add domain to Mailgun
			const response = await mgClient.domains.create({
				name: domain,
				web_scheme: "https",
				smtp_password: "temp-password", // Required by Mailgun API
			});

			const domainInfo = response as any;
			
			// Return DKIM tokens for DNS setup
			const tokens: string[] = [];
			if (domainInfo.dkim_selector) {
				tokens.push(domainInfo.dkim_selector);
			}

			return tokens;
		} catch (error: any) {
			// If domain already exists, get its info
			if (error.status === 400 && error.message?.includes("already exists")) {
				try {
					const response = await mgClient.domains.get(domain);
					const domainInfo = response as any;
					
					const tokens: string[] = [];
					if (domainInfo.dkim_selector) {
						tokens.push(domainInfo.dkim_selector);
					}
					return tokens;
				} catch (getError: any) {
					signale.warn(`Failed to get existing domain info for ${domain}: ${getError.message}`);
					return [];
				}
			}
			signale.warn(`Failed to create domain for ${domain}: ${error.message}`);
			throw error;
		}
	}

	private async getIdentityVerificationAttributes(email: string) {
		const domain = email.split("@")[1];

		try {
			const response = await mgClient.domains.get(domain);
			const domainInfo = response as any;

			// Map Mailgun status to SES-like status
			let status = "Failed";
			if (domainInfo.status === "active") {
				status = "Success";
			} else if (domainInfo.status === "unverified") {
				status = "PendingVerification";
			}

			const tokens: string[] = [];
			if (domainInfo.dkim_selector) {
				tokens.push(domainInfo.dkim_selector);
			}

			return {
				email: domain,
				tokens,
				status,
			};
		} catch (error: any) {
			// Domain not found or other error
			signale.warn(`Failed to get verification attributes for ${domain}: ${error.message}`);
			return {
				email: domain,
				tokens: [],
				status: "Failed",
			};
		}
	}
}
