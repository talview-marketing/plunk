import { Controller, Delete, Get, Middleware, Post, Put } from "@overnightjs/core";
import { CampaignSchemas, UtilitySchemas } from "@plunk/shared";
import dayjs from "dayjs";
import type { Request, Response } from "express";
import { prisma } from "../../database/prisma";
import { HttpException, NotAllowed, NotFound } from "../../exceptions";
import { type IJwt, type ISecret, isAuthenticated, isValidSecretKey } from "../../middleware/auth";
import { CampaignService } from "../../services/CampaignService";
import { EmailService } from "../../services/EmailService";
import { MembershipService } from "../../services/MembershipService";
import { ProjectService } from "../../services/ProjectService";
import { Keys } from "../../services/keys";
import { redis } from "../../services/redis";

@Controller("campaigns")
export class Campaigns {
	@Get(":id")
	@Middleware([isAuthenticated])
	public async getCampaignById(req: Request, res: Response) {
		const { id } = UtilitySchemas.id.parse(req.params);

		const { userId } = res.locals.auth as IJwt;

		const campaign = await CampaignService.id(id);

		if (!campaign) {
			throw new NotFound("campaign");
		}

		const isMember = await MembershipService.isMember(campaign.projectId, userId);

		if (!isMember) {
			throw new NotFound("campaign");
		}

		return res.status(200).json(campaign);
	}

	@Post("send")
	@Middleware([isValidSecretKey])
	public async sendCampaign(req: Request, res: Response) {
		const { sk } = res.locals.auth as ISecret;

		const project = await ProjectService.secret(sk);

		if (!project) {
			throw new NotFound("project");
		}

		const { id, live, delay: userDelay } = CampaignSchemas.send.parse(req.body);

		const campaign = await CampaignService.id(id);

		if (!campaign || campaign.projectId !== project.id) {
			throw new NotFound("campaign");
		}

		if (live) {
			if (campaign.recipients.length === 0) {
				throw new HttpException(400, "No recipients found");
			}

			// Only queued at this point, nothing has been sent yet. Tasks.handleTasks
			// promotes this to DELIVERED once the queue drains with emails actually sent.
			await prisma.campaign.update({
				where: { id: campaign.id },
				data: { status: "SCHEDULED" },
			});

			await prisma.event.createMany({
				data: [
					{
						projectId: project.id,
						name: `${campaign.subject
							.toLowerCase()
							.replace(/[.,/#!$%^&*;:{}=\-_`~()]/g, "")
							.replace(/ /g, "-")}-campaign-delivered`,
						campaignId: campaign.id,
					},
					{
						projectId: project.id,
						name: `${campaign.subject
							.toLowerCase()
							.replace(/[.,/#!$%^&*;:{}=\-_`~()]/g, "")
							.replace(/ /g, "-")}-campaign-opened`,
						campaignId: campaign.id,
					},
				],
			});

			let delay = userDelay ?? 0;

			const tasks = campaign.recipients.map((r, index) => {
				if (index % 80 === 0) {
					delay += 1;
				}

				return {
					campaignId: campaign.id,
					contactId: r.id,
					runBy: dayjs().add(delay, "minutes").toDate(),
				};
			});

			await prisma.task.createMany({ data: tasks });
		} else {
			const members = await ProjectService.memberships(project.id);

			await EmailService.send({
				from: {
					name: project.from ?? project.name,
					email: project.verified && project.email ? project.email : "",
				},
				to: members.map((m) => m.email),
				content: {
					subject: `[Plunk Campaign Test] ${campaign.subject}`,
					html: EmailService.compile({
						content: campaign.body,
						footer: {
							unsubscribe: false,
						},
						contact: {
							id: "",
						},
						project: {
							name: project.name,
						},
					}),
				},
			});
		}

		await redis.del(Keys.Campaign.id(campaign.id));
		await redis.del(Keys.Project.campaigns(project.id));

		return res.status(200).json({});
	}

	@Post("duplicate")
	@Middleware([isValidSecretKey])
	public async duplicateCampaign(req: Request, res: Response) {
		const { sk } = res.locals.auth as ISecret;

		const project = await ProjectService.secret(sk);

		if (!project) {
			throw new NotFound("project");
		}

		const { id } = UtilitySchemas.id.parse(req.body);

		const campaign = await CampaignService.id(id);

		if (!campaign) {
			throw new NotFound("campaign");
		}

		const duplicatedCampaign = await prisma.campaign.create({
			data: {
				projectId: project.id,
				subject: campaign.subject,
				body: campaign.body,
				style: campaign.style,
				email: campaign.email,
				from: campaign.from,
			},
		});

		await redis.del(Keys.Campaign.id(campaign.id));
		await redis.del(Keys.Project.campaigns(project.id));

		return res.status(200).json(duplicatedCampaign);
	}

	@Post()
	@Middleware([isValidSecretKey])
	public async createCampaign(req: Request, res: Response) {
		const { sk } = res.locals.auth as ISecret;

		const project = await ProjectService.secret(sk);

		if (!project) {
			throw new NotFound("project");
		}

		const { subject, body, recipients, style, email, from } = CampaignSchemas.create.parse(req.body);

		if (email && !project.verified) {
			throw new NotAllowed("You need to attach a domain to your project to customize the sender address");
		}

		if (email && email.split("@")[1] !== project.email?.split("@")[1]) {
			throw new NotAllowed("The sender address must be the same domain as the project's email address");
		}

		const campaign = await prisma.campaign.create({
			data: {
				projectId: project.id,
				subject,
				body,
				style,
				from: from === "" ? null : from,
				email: email === "" ? null : email,
			},
		});

		await CampaignService.setRecipients(campaign.id, project.id, recipients);

		await redis.del(Keys.Campaign.id(campaign.id));
		await redis.del(Keys.Project.campaigns(project.id));

		return res.status(200).json(campaign);
	}

	@Put()
	@Middleware([isValidSecretKey])
	public async updateCampaign(req: Request, res: Response) {
		const { sk } = res.locals.auth as ISecret;

		const project = await ProjectService.secret(sk);

		if (!project) {
			throw new NotFound("project");
		}

		const { id, subject, body, recipients, style, email, from } = CampaignSchemas.update.parse(req.body);

		if (email && !project.verified) {
			throw new NotAllowed("You need to attach a domain to your project to customize the sender address");
		}

		if (email && email.split("@")[1] !== project.email?.split("@")[1]) {
			throw new NotAllowed("The sender address must be the same domain as the project's email address");
		}

		const existing = await CampaignService.id(id);

		if (!existing || existing.projectId !== project.id) {
			throw new NotFound("campaign");
		}

		const campaign = await prisma.campaign.update({
			where: { id },
			data: {
				subject,
				body,
				style,
				from: from === "" ? null : from,
				email: email === "" ? null : email,
			},
		});

		await CampaignService.setRecipients(campaign.id, project.id, recipients);

		await redis.del(Keys.Campaign.id(campaign.id));
		await redis.del(Keys.Project.campaigns(project.id));

		return res.status(200).json(campaign);
	}

	@Delete()
	@Middleware([isValidSecretKey])
	public async deleteCampaign(req: Request, res: Response) {
		const { sk } = res.locals.auth as ISecret;

		const project = await ProjectService.secret(sk);

		if (!project) {
			throw new NotFound("project");
		}

		const { id } = UtilitySchemas.id.parse(req.body);

		const campaign = await CampaignService.id(id);

		if (!campaign || campaign.projectId !== project.id) {
			throw new NotFound("campaign");
		}

		await prisma.campaign.delete({ where: { id } });

		await redis.del(Keys.Campaign.id(campaign.id));
		await redis.del(Keys.Project.campaigns(project.id));

		return res.status(200).json(campaign);
	}
}
