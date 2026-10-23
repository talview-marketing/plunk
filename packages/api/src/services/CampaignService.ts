import {Keys} from './keys';
import {wrapRedis} from './redis';
import {prisma} from '../database/prisma';
import {ContactService} from './ContactService';

// The campaign page lists the latest emails only; totals come from _count
export const CAMPAIGN_EMAILS_SHOWN = 500;

export class CampaignService {
  public static id(id: string) {
    return wrapRedis(Keys.Campaign.id(id), async () => {
      return prisma.campaign.findUnique({
        where: {id},
        include: {
          recipients: {select: {id: true}},
          emails: {
            select: {id: true, status: true, contact: {select: {id: true, email: true}}},
            orderBy: {updatedAt: 'desc'},
            take: CAMPAIGN_EMAILS_SHOWN,
          },
          _count: {select: {emails: true}},
        },
      });
    });
  }

  /**
   * Replaces the recipients of a campaign. Contact ids from another project are ignored.
   * @param campaignId
   * @param projectId
   * @param recipients Contact ids, email addresses (created as contacts if new) or ["all"] for every subscribed contact
   */
  public static async setRecipients(campaignId: string, projectId: string, recipients: string[]) {
    await prisma.$executeRaw`DELETE FROM "_CampaignToContact" WHERE "A" = ${campaignId}`;

    if (recipients.length === 1 && recipients[0] === 'all') {
      await prisma.$executeRaw`
        INSERT INTO "_CampaignToContact" ("A", "B")
        SELECT ${campaignId}, "id" FROM "contacts" WHERE "projectId" = ${projectId} AND "subscribed" = true
        ON CONFLICT DO NOTHING`;
      return;
    }

    const chunkSize = 500;

    for (let i = 0; i < recipients.length; i += chunkSize) {
      const chunk = recipients.slice(i, i + chunkSize);

      const ids = await Promise.all(
        chunk.map(async recipient => {
          if (!recipient.includes('@')) {
            return recipient;
          }

          let contact = await ContactService.email(recipient, projectId);

          if (!contact) {
            contact = await prisma.contact.create({data: {email: recipient, projectId, subscribed: true}});
          }

          return contact.id;
        }),
      );

      await prisma.$executeRaw`
        INSERT INTO "_CampaignToContact" ("A", "B")
        SELECT ${campaignId}, "id" FROM "contacts" WHERE "id" = ANY(${ids}) AND "projectId" = ${projectId}
        ON CONFLICT DO NOTHING`;
    }
  }
}
