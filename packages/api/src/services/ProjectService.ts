import type { CampaignSchemas } from "@plunk/shared";
import type { Prisma } from "@prisma/client";
import dayjs from "dayjs";
import type z from "zod";
import { prisma } from "../database/prisma";
import { Keys } from "./keys";
import { wrapRedis } from "./redis";

export class ProjectService {
	public static contacts = {
		get: (id: string) => {
			return wrapRedis(Keys.Project.contacts(id), async () => {
				return prisma.project.findUnique({ where: { id } }).contacts({
					select: {
						id: true,
						email: true,
						subscribed: true,
						createdAt: true,
						data: true,
						updatedAt: true,
						triggers: { select: { createdAt: true, eventId: true } },
					},
				});
			});
		},

		paginated: (id: string, page: number) => {
			return wrapRedis(Keys.Project.contacts(id, { page }), async () => {
				return prisma.project.findUnique({ where: { id } }).contacts({
					select: {
						id: true,
						email: true,
						subscribed: true,
						createdAt: true,
						triggers: { select: { createdAt: true } },
						emails: { select: { createdAt: true } },
					},
					orderBy: [{ createdAt: "desc" }],
					take: 20,
					skip: (page - 1) * 20,
				});
			});
		},

		count: (id: string) => {
			return wrapRedis(Keys.Project.contacts(id, { count: true }), async () => {
				return prisma.contact.count({ where: { projectId: id } });
			});
		},

		// Just what the campaign recipient picker shows, so opening a campaign no longer loads every contact with all its triggers
		recipients: (id: string) => {
			return prisma.contact.findMany({
				where: { projectId: id, subscribed: true },
				select: { id: true, email: true },
				orderBy: { createdAt: "desc" },
			});
		},

		// Runs the campaign advanced selector in the database instead of in the browser
		audience: async (id: string, query: z.infer<typeof CampaignSchemas.audience>) => {
			const since = (period: "day" | "week" | "month") => ({ gte: dayjs().subtract(1, period).toDate() });

			const conditions: Prisma.ContactWhereInput[] = [];

			for (const eventId of query.events ?? []) {
				conditions.push({ triggers: { some: { eventId, ...(query.last && { createdAt: since(query.last) }) } } });
			}

			if (query.notevents && query.notevents.length > 0) {
				for (const eventId of query.notevents) {
					conditions.push({ triggers: { none: { eventId, ...(query.notlast && { createdAt: since(query.notlast) }) } } });
				}
			} else if (query.notlast) {
				conditions.push({ triggers: { none: { createdAt: since(query.notlast) } } });
			}

			if (query.data) {
				// Narrows down in SQL to contacts whose data mentions the key; the exact match happens below
				conditions.push({ data: { contains: JSON.stringify(query.data) } });
			}

			const contacts = await prisma.contact.findMany({
				where: { projectId: id, subscribed: true, AND: conditions },
				select: { id: true, data: !!query.data },
			});

			if (!query.data) {
				return contacts.map((c) => c.id);
			}

			const key = query.data;

			return contacts
				.filter((c) => {
					const value = c.data ? JSON.parse(c.data)[key] : undefined;

					if (!value) {
						return false;
					}

					if (!query.value) {
						return true;
					}

					return Array.isArray(value) ? value.includes(query.value) : value === query.value;
				})
				.map((c) => c.id);
		},
	};

	public static emails = {
		get: (id: string) => {
			return wrapRedis(Keys.Project.emails(id), async () => {
				return prisma.email.findMany({
					where: {
						OR: [{ action: { projectId: id } }, { campaign: { projectId: id } }, { projectId: id }],
					},
					orderBy: { createdAt: "desc" },
				});
			});
		},
		count: (id: string) => {
			return wrapRedis(Keys.Project.emails(id, { count: true }), async () => {
				return prisma.email.count({ where: { contact: { projectId: id } } });
			});
		},
	};

	public static id(id: string) {
		return wrapRedis(Keys.Project.id(id), async () => {
			return prisma.project.findUnique({ where: { id } });
		});
	}

	public static key(key: string) {
		if (key.startsWith("sk_")) {
			return ProjectService.secret(key);
		}
		return ProjectService.public(key);
	}

	public static secret(secretKey: string) {
		return wrapRedis(Keys.Project.secret(secretKey), () => {
			return prisma.project.findUnique({ where: { secret: secretKey } });
		});
	}

	public static public(publicKey: string) {
		return wrapRedis(Keys.Project.public(publicKey), () => {
			return prisma.project.findUnique({ where: { public: publicKey } });
		});
	}

	public static async secretIsAvailable(secretKey: string) {
		const project = await ProjectService.secret(secretKey);

		return !project;
	}

	public static async publicIsAvailable(publicKey: string) {
		const project = await ProjectService.public(publicKey);

		return !project;
	}

	public static memberships(id: string) {
		return wrapRedis(Keys.Project.memberships(id), async () => {
			const memberships = await prisma.project.findUnique({ where: { id } }).memberships({ include: { user: true } });

			if (!memberships) {
				return [];
			}

			return memberships.map((membership) => {
				return {
					userId: membership.userId,
					email: membership.user.email,
					role: membership.role,
				};
			});
		});
	}

	public static metadata(id: string) {
		return wrapRedis(Keys.Project.metadata(id), async () => {
			const contacts = await prisma.project.findUnique({ where: { id } }).contacts({
				where: {
					data: {
						not: null,
					},
				},
				distinct: ["data"],
				select: {
					data: true,
				},
			});

			if (!contacts) {
				return [];
			}

			return [...new Set(contacts.filter((c) => c.data).flatMap((c) => Object.keys(JSON.parse(c.data as string))))];
		});
	}

	public static async metadataValues(id: string, key: string) {
		const contacts = await prisma.contact.findMany({
			where: { projectId: id, data: { contains: JSON.stringify(key) } },
			distinct: ["data"],
			select: { data: true },
		});

		return [
			...new Set(
				contacts
					.flatMap((c) => JSON.parse(c.data as string)[key] ?? [])
					.filter((v: unknown): v is string => typeof v === "string" && v !== ""),
			),
		];
	}

	public static async feed(id: string, page: number) {
		const itemsPerPage = 10;
		const skip = (page - 1) * itemsPerPage;

		// The newest skip + itemsPerPage rows of each source are enough to build this page of the
		// merged feed, so the rest of the project's history is never loaded
		const take = skip + itemsPerPage;

		const triggers = await prisma.trigger.findMany({
			where: { contact: { projectId: id } },
			include: {
				contact: {
					select: {
						id: true,
						email: true,
					},
				},
				event: {
					select: {
						name: true,
					},
				},
			},
			orderBy: { createdAt: "desc" },
			take,
		});

		// Leaves out subject and body: bodies are full HTML documents and the feed never shows them
		const emails = await prisma.email.findMany({
			where: { contact: { projectId: id } },
			select: {
				id: true,
				messageId: true,
				status: true,
				projectId: true,
				actionId: true,
				campaignId: true,
				contactId: true,
				createdAt: true,
				updatedAt: true,
				contact: {
					select: {
						id: true,
						email: true,
					},
				},
			},
			orderBy: { createdAt: "desc" },
			take,
		});

		const combined = [...triggers, ...emails];
		combined.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

		return combined.slice(skip, skip + itemsPerPage);
	}

	public static usage(id: string) {
		return wrapRedis(Keys.Project.usage(id), async () => {
			const transactional = await prisma.email.count({
				where: {
					projectId: id,
					createdAt: {
						gte: new Date(dayjs().startOf("month").toISOString()),
						lte: new Date(dayjs().endOf("month").toISOString()),
					},
				},
			});

			const automation = await prisma.email.count({
				where: {
					action: { projectId: id },
					createdAt: {
						gte: new Date(dayjs().startOf("month").toISOString()),
						lte: new Date(dayjs().endOf("month").toISOString()),
					},
				},
			});

			const campaign = await prisma.email.count({
				where: {
					campaign: { projectId: id },
					createdAt: {
						gte: new Date(dayjs().startOf("month").toISOString()),
						lte: new Date(dayjs().endOf("month").toISOString()),
					},
				},
			});

			return {
				transactional,
				automation,
				campaign,
			};
		});
	}

	public static events(id: string, triggers: boolean) {
		return wrapRedis(Keys.Project.events(id, triggers), async () => {
			if (triggers) {
				return prisma.project.findUnique({ where: { id } }).events({
					include: {
						triggers: {
							select: { id: true, createdAt: true, contactId: true },
						},
					},
					orderBy: { createdAt: "desc" },
				});
			}
			return prisma.project.findUnique({ where: { id } }).events({
				orderBy: { createdAt: "desc" },
			});
		});
	}

	public static actions(id: string) {
		return wrapRedis(Keys.Project.actions(id), async () => {
			return prisma.project.findUnique({ where: { id } }).actions({
				include: {
					triggers: { select: { id: true } },
					template: true,
					emails: { select: { id: true, status: true } },
					tasks: { select: { id: true } },
				},
			});
		});
	}

	public static templates(id: string) {
		return wrapRedis(Keys.Project.templates(id), async () => {
			return prisma.project.findUnique({ where: { id } }).templates({
				include: { actions: true },
				orderBy: { createdAt: "desc" },
			});
		});
	}

	public static campaigns(id: string) {
		return wrapRedis(Keys.Project.campaigns(id), async () => {
			// Counts only: loading every recipient, email and task of every campaign timed out on large projects
			const campaigns = await prisma.campaign.findMany({
				where: { projectId: id },
				include: {
					_count: {
						select: {
							recipients: true,
							emails: true,
							tasks: true,
						},
					},
				},
				orderBy: { createdAt: "desc" },
			});

			const opened = await prisma.email.groupBy({
				by: ["campaignId"],
				where: { campaignId: { in: campaigns.map((c) => c.id) }, status: "OPENED" },
				_count: { _all: true },
			});

			return campaigns.map((c) => ({
				...c,
				_count: { ...c._count, opened: opened.find((o) => o.campaignId === c.id)?._count._all ?? 0 },
			}));
		});
	}

	public static analytics(params: {
		id: string;
		method?: "week" | "month" | "year";
	}) {
		return wrapRedis(Keys.Project.analytics(params.id), async () => {
			const methods = {
				week: {
					daysBack: 7,
					method: "week",
				},
				month: {
					daysBack: 30,
					method: "day",
				},
				year: {
					daysBack: 365,
					method: "month",
				},
			};

			const end = dayjs().toDate();
			const start = dayjs()
				.subtract(methods[params.method ?? "week"].daysBack, "days")
				.toDate();

			const contacts = await prisma.$queryRaw`
WITH date_range AS (
    SELECT generate_series(
        (SELECT DATE_TRUNC('day', MIN("createdAt")) FROM contacts),
        DATE_TRUNC('day', NOW()) + INTERVAL '1 day',
        INTERVAL '1 day'
    ) AS day
)

SELECT
    dr.day,
    SUM(COALESCE(ct.count, 0)) OVER (ORDER BY dr.day) as count
FROM date_range dr
LEFT JOIN (
    SELECT
        DATE_TRUNC('day', c."createdAt") AS day,
        COUNT(c.id) as count
    FROM contacts c
    WHERE "projectId" = ${params.id}
    GROUP BY DATE_TRUNC('day', c."createdAt")
) ct ON dr.day = ct.day
WHERE dr.day < DATE_TRUNC('day', NOW())
ORDER BY dr.day DESC
LIMIT 30;
      
      `;

			const rawActionClicks = await prisma.$queryRaw`
SELECT clicks."link", a."name", count(clicks.id)::int FROM clicks
JOIN emails e on clicks."emailId" = e.id
JOIN actions a on e."actionId" = a.id
WHERE clicks."link" NOT LIKE '%unsubscribe%' AND DATE(clicks."createdAt") BETWEEN DATE(${start}) AND DATE(${end}) AND a."projectId" = ${params.id}
GROUP BY a."name", clicks."link"
      `;

			const combinedRoutes = {};

			// @ts-expect-error
			rawActionClicks.forEach((item) => {
				const url = new URL(item.link);
				const route = url.pathname;
				// @ts-expect-error
				if (combinedRoutes[route]) {
					// @ts-expect-error
					combinedRoutes[route].count += item.count;
				} else {
					// @ts-expect-error
					combinedRoutes[route] = {
						link: url.hostname + route,
						name: item.name,
						count: item.count,
					};
				}
			});

			const formattedActionClicks = Object.values(combinedRoutes).sort(
				// @ts-expect-error
				(a, b) => b.count - a.count,
			);

			const subscribed = await prisma.contact.count({
				where: { subscribed: true, projectId: params.id },
			});
			const unsubscribed = await prisma.contact.count({
				where: { subscribed: false, projectId: params.id },
			});

			const opened = await prisma.email.count({
				where: {
					contact: { projectId: params.id },
					status: "OPENED",
				},
			});

			const openedPrev = await prisma.email.count({
				where: {
					contact: { projectId: params.id },
					status: "OPENED",
					createdAt: {
						lte: start,
					},
				},
			});

			const bounced = await prisma.email.count({
				where: {
					contact: { projectId: params.id },
					status: "BOUNCED",
				},
			});

			const bouncedPrev = await prisma.email.count({
				where: {
					contact: { projectId: params.id },
					status: "BOUNCED",
					createdAt: {
						lte: start,
					},
				},
			});

			const complaint = await prisma.email.count({
				where: {
					contact: { projectId: params.id },
					status: "COMPLAINT",
				},
			});

			const complaintPrev = await prisma.email.count({
				where: {
					contact: { projectId: params.id },
					status: "COMPLAINT",
					createdAt: {
						lte: start,
					},
				},
			});

			const total = await prisma.email.count({
				where: {
					contact: { projectId: params.id },
				},
			});

			const totalPrev = await prisma.email.count({
				where: {
					contact: { projectId: params.id },
					createdAt: {
						lte: start,
					},
				},
			});

			return {
				contacts: { timeseries: contacts, subscribed, unsubscribed },
				emails: {
					total,
					opened,
					bounced,
					complaint,
					totalPrev,
					bouncedPrev,
					complaintPrev,
					openedPrev,
				},
				clicks: {
					actions: formattedActionClicks,
				},
			};
		});
	}
}
