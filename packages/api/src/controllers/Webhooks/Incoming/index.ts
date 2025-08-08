import {ChildControllers, Controller} from '@overnightjs/core';
// import {SNSWebhook} from './SNS';
import { MailgunWebhook } from "../Incoming/Mailgun";

@Controller('incoming')
// @ChildControllers([new SNSWebhook(),  new MailgunWebhook(),]
@ChildControllers([new MailgunWebhook(),]
 )
export class IncomingWebhooks {}
