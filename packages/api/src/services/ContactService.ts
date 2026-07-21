import {Keys} from './keys';
import {redis, wrapRedis} from './redis';
import {prisma} from '../database/prisma';

export class ContactService {
  public static id(id: string) {
    return wrapRedis(Keys.Contact.id(id), async () => {
      return prisma.contact.findUnique({
        where: {id},
        include: {triggers: {include: {event: true, action: true}}, emails: {where: {subject: {not: null}}}},
      });
    });
  }

  public static email(projectId: string, email: string) {
    return wrapRedis(Keys.Contact.email(projectId, email), () => {
      return prisma.contact.findFirst({where: {projectId, email}});
    });
  }

  public static async triggers(id: string) {
    return prisma.contact.findUniqueOrThrow({where: {id}}).triggers();
  }


  public static normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
  }

 
  public static findByEmail(projectId: string, email: string) {
    return prisma.contact.findFirst({where: {projectId, email: this.normalizeEmail(email)}});
  }


  public static async upsert(
    projectId: string,
    email: string,
    data?: Record<string, unknown>,
    subscribed?: boolean,
  ): Promise<{created: boolean}> {
    const normalized = this.normalizeEmail(email);
    const existing = await prisma.contact.findFirst({where: {projectId, email: normalized}});

    if (existing) {
      const merged = JSON.parse(existing.data ?? '{}');

      if (data) {
        for (const [key, value] of Object.entries(data)) {
          if (value === undefined || value === null || value === '') {
            delete merged[key];
          } else {
            merged[key] = value;
          }
        }
      }

      await prisma.contact.update({
        where: {id: existing.id},
        data: {
          data: Object.keys(merged).length > 0 ? JSON.stringify(merged) : existing.data,
          subscribed: subscribed ?? existing.subscribed,
        },
      });

      await redis.del(Keys.Project.contacts(projectId));
      await redis.del(Keys.Contact.id(existing.id));
      await redis.del(Keys.Contact.email(projectId, normalized));

      return {created: false};
    }

    const contact = await prisma.contact.create({
      data: {
        projectId,
        email: normalized,
        subscribed: subscribed ?? true,
        data: data && Object.keys(data).length > 0 ? JSON.stringify(data) : null,
      },
    });

    await redis.del(Keys.Project.contacts(projectId));
    await redis.del(Keys.Contact.id(contact.id));
    await redis.del(Keys.Contact.email(projectId, normalized));

    return {created: true};
  }
}
