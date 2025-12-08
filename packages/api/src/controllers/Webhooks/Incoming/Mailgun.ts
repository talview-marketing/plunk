import { Controller, Post } from "@overnightjs/core";
import type { Event, EmailStatus } from "@prisma/client";
import type { Request, Response } from "express";
import signale from "signale";
import { prisma } from "../../../database/prisma";
import { ActionService } from "../../../services/ActionService";
import { ProjectService } from "../../../services/ProjectService";

const eventMap: Record<string, EmailStatus> = {
  bounced: "BOUNCED",
  delivered: "DELIVERED",
  opened: "OPENED",
  complained: "COMPLAINT",
  clicked: "DELIVERED",
  unsubscribed: "COMPLAINT", 
} as const;

@Controller("mailgun")
export class MailgunWebhook {
  @Post()
  public async receiveMailgunWebhook(req: Request, res: Response) {
    try {
      const body = req.body;

      const email = await prisma.email.findUnique({
        where: { messageId: body["message-id"] },
        include: {
          contact: true,
          action: { include: { template: { include: { events: true } } } },
          campaign: { include: { events: true } },
        },
      });

      if (!email) return res.status(200).json({});

      const project = await ProjectService.id(email.contact.projectId);
      if (!project) return res.status(200).json({ success: false });

      
      switch (body.event) {
        case "clicked":
          signale.success(
            `Click received for ${email.contact.email} from ${project.name}`
          );
          await prisma.click.create({
            data: { emailId: email.id, link: body.url },
          });
          break;

        case "complained":
          signale.warn(
            `Complaint for ${email.contact.email} from ${project.name}`
          );
          await prisma.contact.update({
            where: { id: email.contactId },
            data: { subscribed: false },
          });
          break;

        case "bounced":
          signale.warn(
            `Bounce for ${email.contact.email} from ${project.name}`
          );
          await prisma.contact.update({
            where: { id: email.contactId },
            data: { subscribed: false },
          });
          break;

        case "unsubscribed":
          signale.warn(
            `Unsubscribe for ${email.contact.email} from ${project.name}`
          );
          await prisma.contact.update({
            where: { id: email.contactId },
            data: { subscribed: false },
          });
          break;
      }

  
      await prisma.email.update({
        where: { messageId: body["message-id"] },
        data: {
          status: eventMap[body.event] ?? "DELIVERED",
        },
      });

   
      if (email.action) {
        let event: Event | undefined;

        if (body.event === "delivered") {
          event = email.action.template.events.find((e) =>
            e.name.includes("delivered")
          );
        } else if (body.event === "opened") {
          event = email.action.template.events.find((e) =>
            e.name.includes("opened")
          );
        }

        if (event) {
          await prisma.trigger.create({
            data: { contactId: email.contactId, eventId: event.id },
          });

          void ActionService.trigger({ event, contact: email.contact, project });
        }
      }

      return res.status(200).json({ success: true });
    } catch (err) {
      signale.error(err);
      return res.status(200).json({ success: false });
    }
  }
}
