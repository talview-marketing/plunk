import mjml2html from "mjml";
import signale from "signale";
import { APP_URI, NODE_ENV } from "../app/constants";
import { mgClient, DOMAIN } from "../services/mailgun";

const DEFAULT_FROM = process.env.MAILGUN_FROM_ADDRESS;

export class EmailService {
  public static async send({
    from,
    to,
    content,
    reply,
    headers,
  }: {
    from: {
      name: string;
      email: string;
    };
    to: string[];
    content: {
      subject: string;
      html: string;
      text?: string;
    };
    reply?: string;
    headers?: {
      [key: string]: string;
    } | null;
  }) {
  
    if (!DOMAIN || !DEFAULT_FROM) {
      // Locally it is useful to run without Mailgun credentials. In production a
      // missing config means every email silently disappears, so fail loudly.
      if (NODE_ENV === "development") {
        signale.warn("Mailgun not configured, skipping email send");
        return { messageId: `mock-${Date.now()}` };
      }

      throw new Error("Mailgun is not configured: MAILGUN_DOMAIN and MAILGUN_FROM_ADDRESS are required");
    }

    const senderEmail = from.email || DEFAULT_FROM;
    const senderDomain = senderEmail.split("@")[1] || DOMAIN;

    const messageData: Record<string, any> = {
      from: from.name ? `${from.name} <${senderEmail}>` : senderEmail,
      to: to.join(", "),
      subject: content.subject,
      html: content.html,
      "h:X-Mailgun-Track": "yes",
      "h:X-Mailgun-Track-Clicks": "htmlonly",
      "h:X-Mailgun-Track-Opens": "yes",
      "h:Precedence": "bulk",
    };

  
    const textContent = content.text || EmailService.stripHtml(content.html);
    if (textContent) {
      messageData.text = textContent;
    }

    if (reply) {
      messageData["h:Reply-To"] = reply;
    }

    if (headers) {
      for (const [key, value] of Object.entries(headers)) {
        if (typeof value === 'string') {
          messageData[`h:${key}`] = value;
        }
      }
    }

    try {
      const result = await mgClient.messages.create(senderDomain, messageData as any);
      if (!result.id) {
        throw new Error("Mailgun did not return a message ID");
      }
      return { messageId: result.id };
    } catch (err: any) {
      // Never swallow this. Returning a fake message id makes a failed send look
      // like a delivered one, both in the logs and in the campaign counts.
      signale.error(
        `Mailgun send failed for ${to.join(", ")} via domain "${senderDomain}": ${err?.status ?? ""} ${
          err?.details ?? err?.message ?? err
        }`,
      );

      throw err;
    }
  }

  public static compile({
    content,
    project,
    isHtml,
    footer,
  contact,
  }: {
    content: string;
    project: {
      name: string;
    };
     footer?: {
    unsubscribe?: boolean;
  };
  contact?: {
    id: string;
  };
    isHtml?: boolean;
  }) {
    if (isHtml) {
      return content;
    }

    const mjmlTemplate = `
    <mjml>
      <mj-head>
        <mj-title>${project.name}</mj-title>
        <mj-attributes>
          <mj-text font-family="Arial, sans-serif" font-size="14px" line-height="1.6" color="#333333" />
        </mj-attributes>
      </mj-head>
      <mj-body background-color="#f4f4f4">
        <mj-section>
          <mj-column>
            <mj-text>
              ${content}
            </mj-text>
          </mj-column>
        </mj-section>
      </mj-body>
    </mjml>
    `;

    const { html: compiledHtml, errors } = mjml2html(mjmlTemplate, { validationLevel: "strict" });
    if (errors && errors.length) {
      console.warn("MJML compile warnings/errors:", errors);
    }
    return compiledHtml;
  }

  public static format({
    subject,
    body,
    data,
  }: {
    subject: string;
    body: string;
    data: Record<string, string>;
  }) {
    return {
      subject: subject.replace(/\{\{(.*?)}}/g, (match, key) => {
        const [mainKey, defaultValue] = key.split("??").map((s: string) => s.trim());
        return data[mainKey] ?? defaultValue ?? "";
      }),
      body: body.replace(/\{\{(.*?)}}/g, (match, key) => {
        const [mainKey, defaultValue] = key.split("??").map((s: string) => s.trim());
        if (Array.isArray(data[mainKey])) {
          return data[mainKey].map((e: string) => `<li>${e}</li>`).join("\n");
        }
        return data[mainKey] ?? defaultValue ?? "";
      }),
    };
  }

  private static stripHtml(html: string): string {
    return html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
  }
}
