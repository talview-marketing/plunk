import {ChildControllers, Controller} from '@overnightjs/core';
import {IncomingWebhooks} from './Incoming';
import { MailgunWebhook } from "./Incoming/Mailgun";
@Controller('webhooks')
@ChildControllers([new IncomingWebhooks()])
export class Webhooks {
  public constructor() {
    // new SNSWebhook();
    new MailgunWebhook();
  }
}
