import { Controller, Get, Middleware, Post } from "@overnightjs/core";
import { IdentitySchemas, UtilitySchemas } from "@plunk/shared";
import type { Request, Response } from "express";
import signale from "signale";
import { randomBytes } from "crypto";
import { prisma } from "../database/prisma";
import { NotAllowed, NotFound } from "../exceptions";
import { type IJwt, isAuthenticated } from "../middleware/auth";
import { MembershipService } from "../services/MembershipService";
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

		const domain = project.email.split("@")[1];
		const attributes = await this.getDomainStatus(domain);

		if (attributes.verified && !project.verified) {
			await prisma.project.update({ where: { id }, data: { verified: true } });

			await redis.del(Keys.Project.id(project.id));
			await redis.del(Keys.Project.secret(project.secret));
			await redis.del(Keys.Project.public(project.public));
		}

		return res.status(200).json({ records: attributes.records });
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

		const isAdmin = await MembershipService.isAdmin(id, userId);

		if (!isAdmin) {
			throw new NotAllowed();
		}

		const domain = email.split("@")[1];

		const records = await this.registerDomain(domain);

		await prisma.project.update({
			where: { id },
			data: { email, verified: false },
		});

		await redis.del(Keys.User.projects(userId));
		await redis.del(Keys.Project.id(project.id));

		return res.status(200).json({ success: true, records });
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

		const isAdmin = await MembershipService.isAdmin(id, userId);

		if (!isAdmin) {
			throw new NotAllowed();
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
	public async updateIdentitiesApi(req: Request, res: Response) {
		await (new Identities().updateIdentities());
		return res.status(200).json({ success: true });
	}

	public async updateIdentities() {
		const count = await prisma.project.count({
			where: { email: { not: null } },
		});

		for (let i = 0; i < count; i += 99) {
			const dbIdentities = await prisma.project.findMany({
				where: { email: { not: null } },
				select: { id: true, email: true, verified: true },
				skip: i,
				take: 99,
			});

			for (const identity of dbIdentities) {
				const domain = (identity.email as string).split("@")[1];

				let verified = false;
				try {
					const attributes = await this.getDomainStatus(domain);
					verified = attributes.verified;
				} catch (e) {
					signale.warn(`Failed to refresh verification status for ${domain}: ${(e as Error).message}`);
					continue;
				}

				if (verified === identity.verified) {
					continue;
				}

				await prisma.project.update({
					where: { id: identity.id },
					data: { verified },
				});

				await redis.del(Keys.Project.id(identity.id));

				if (verified) {
					signale.success(`Successfully verified ${domain}`);
				}
			}
		}
	}

	// Mailgun helper methods

	/**
	 * Registers a domain with Mailgun and returns its sending DNS records
	 */
	private async registerDomain(domain: string) {
		try {
			const created = await mgClient.domains.create({
				name: domain,
				web_scheme: "https",
				smtp_password: randomBytes(24).toString("hex"),
			});

			return created.sending_dns_records ?? [];
		} catch (createError: any) {
			// The domain may already exist in this Mailgun account (e.g. re-adding after a reset,
			// or the account's domain quota is already used by this exact domain). Mailgun reports
			// this in different ways (400 "already exists", or 403 "domain limit exceeded"), so
			// rather than pattern-match the message, just check if the domain is actually there.
			try {
				const existing = await mgClient.domains.get(domain);
				return existing.sending_dns_records ?? [];
			} catch {
				signale.warn(
					`Failed to create domain ${domain}: status=${createError?.status} message=${createError?.message} details=${JSON.stringify(createError?.details)} body=${JSON.stringify(createError?.body)}`,
				);
				throw createError;
			}
		}
	}

	/**
	 * Fetches the current verification state + sending DNS records for a domain from Mailgun
	 */
	private async getDomainStatus(domain: string): Promise<{ verified: boolean; records: unknown[] }> {
		try {
			const info = await mgClient.domains.get(domain);

			return {
				verified: info.state === "active",
				records: info.sending_dns_records ?? [],
			};
		} catch (error: any) {
			signale.warn(`Failed to get domain info for ${domain}: ${error.message}`);
			return { verified: false, records: [] };
		}
	}
}
