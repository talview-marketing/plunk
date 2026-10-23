import { Controller, Post } from "@overnightjs/core";
import dayjs from "dayjs";
import type { Request, Response } from "express";
import signale from "signale";
import { prisma } from "../database/prisma";
import { ContactService } from "../services/ContactService";
import { EmailService } from "../services/EmailService";
import { ProjectService } from "../services/ProjectService";
import { Keys } from "../services/keys";
import { redis } from "../services/redis";

@Controller("tasks")
export class Tasks {
	private static running = false;

	@Post()
	// public async handleTasks(req: Request, res: Response) {
	public async handleTasksApi(req: Request, res: Response) {
		await (new Tasks().handleTasks());
		return res.status(200).json({ success: true });
	}

	public async handleTasks() {
		// node-cron starts a new run every minute even if the previous one is still sending.
		// Two overlapping runs would pick up the same due tasks and email those contacts twice.
		if (Tasks.running) {
			signale.warn("Previous task run still in progress, skipping this minute");
			return;
		}

		Tasks.running = true;

		try {
			await this.runDueTasks();
		} finally {
			Tasks.running = false;
		}
	}

	private async runDueTasks() {
		const tasks = await prisma.task.findMany({
			where: { runBy: { lte: new Date() } },
			orderBy: { runBy: "asc" },
			include: {
				action: { include: { template: true, notevents: true } },
				campaign: true,
				contact: true,
			},
		});

		let sent = 0;
		let failed = 0;
		let lastError = "";
		const touchedCampaigns = new Map<string, string>();

		for (const task of tasks) {
			const { action, campaign, contact } = task;

			if (campaign) {
				touchedCampaigns.set(campaign.id, campaign.projectId);
			}

			const project = await ProjectService.id(contact.projectId);

			// If the project does not exist or is disabled, delete all tasks
			if (!project) {
				await prisma.task.deleteMany({
					where: {
						contact: {
							projectId: contact.projectId,
						},
					},
				});
				continue;
			}

			let subject = "";
			let body = "";

			let email = "";
			let name = "";

			if (action) {
				const { template, notevents } = action;

				if (notevents.length > 0) {
					const triggers = await ContactService.triggers(contact.id);
					if (notevents.some((e) => triggers.some((t) => t.contactId === contact.id && t.eventId === e.id))) {
						await prisma.task.delete({ where: { id: task.id } });
						continue;
					}
				}

				email = project.verified && project.email ? template.email ?? project.email : "";
				name = template.from ?? project.from ?? project.name;

				({ subject, body } = EmailService.format({
					subject: template.subject,
					body: template.body,
					data: {
						plunk_id: contact.id,
						plunk_email: contact.email,
						...JSON.parse(contact.data ?? "{}"),
					},
				}));
			} else if (campaign) {
				email = project.verified && project.email ? campaign.email ?? project.email : "";
				name = campaign.from ?? project.from ?? project.name;

				({ subject, body } = EmailService.format({
					subject: campaign.subject,
					body: campaign.body,
					data: {
						plunk_id: contact.id,
						plunk_email: contact.email,
						...JSON.parse(contact.data ?? "{}"),
					},
				}));
			}

			try {
				const { messageId } = await EmailService.send({
					from: {
						name,
						email,
					},
					to: [contact.email],
					content: {
						subject,
						html: EmailService.compile({
							content: body,
							footer: {
								unsubscribe: campaign ? true : !!action && action.template.type === "MARKETING",
							},
							contact: {
								id: contact.id,
							},
							project: {
								name: project.name,
							},
							isHtml: (campaign && campaign.style === "HTML") ?? (!!action && action.template.style === "HTML"),
						}),
					},
				});

				const emailData: {
					messageId: string;
					contactId: string;
					actionId?: string;
					campaignId?: string;
				} = {
					messageId,
					contactId: contact.id,
				};

				if (action) {
					emailData.actionId = action.id;
				} else if (campaign) {
					emailData.campaignId = campaign.id;
				}

				await prisma.email.create({ data: emailData });

				await prisma.task.delete({ where: { id: task.id } });

				sent++;
				signale.success(`Task completed for ${contact.email} from ${project.name}`);
			} catch (e) {
				failed++;
				lastError = (e as Error).message;

				signale.error(`Send FAILED for ${contact.email} from ${project.name}: ${lastError}`);

				// Deliberately no email row: campaign counts must not show a failed send
				// as delivered. Retry with a backoff, then give up so we do not hammer
				// the provider forever on a permanent error. Measured from createdAt, so the
				// window is 48h: a campaign sent with the 24h delay option first runs 24h+
				// after its tasks were created and still needs time left to retry.
				if (dayjs().diff(task.createdAt, "hour") >= 48) {
					await prisma.task.delete({ where: { id: task.id } });
					signale.warn(`Giving up on ${contact.email} from ${project.name} after 48h in the queue`);
				} else {
					await prisma.task.update({
						where: { id: task.id },
						data: { runBy: dayjs().add(15, "minute").toDate() },
					});
				}
			}
		}

		if (sent > 0 || failed > 0) {
			signale.info(`Tasks: ${sent} sent, ${failed} failed${failed > 0 ? ` — last error: ${lastError}` : ""}`);
		}

		// A campaign is only DELIVERED once its queue has drained and something
		// actually went out. Until then it stays SCHEDULED, so a campaign that
		// failed entirely never reports itself as delivered.
		for (const [campaignId, projectId] of touchedCampaigns) {
			const remaining = await prisma.task.count({ where: { campaignId } });

			if (remaining > 0) {
				continue;
			}

			const delivered = await prisma.email.count({ where: { campaignId } });

			if (delivered === 0) {
				signale.warn(`Campaign ${campaignId} drained with 0 emails sent, leaving it as SCHEDULED`);
				continue;
			}

			await prisma.campaign.update({
				where: { id: campaignId },
				data: { status: "DELIVERED", delivered: new Date() },
			});

			await redis.del(Keys.Campaign.id(campaignId));
			await redis.del(Keys.Project.campaigns(projectId));
		}
	}
}
