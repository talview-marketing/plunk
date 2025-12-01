import mjml2html from "mjml";
import { APP_URI } from "../app/constants";
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
      console.warn("Mailgun not configured, skipping email send");
      return { messageId: `mock-${Date.now()}` };
    }

    const messageData: Record<string, any> = {
      from: DEFAULT_FROM,
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
      const result = await mgClient.messages.create(DOMAIN, messageData as any);
      if (!result.id) {
        throw new Error("Mailgun did not return a message ID");
      }
      return { messageId: result.id };
    } catch (err: any) {
      console.error("Mailgun send error:", err);
      
      return { messageId: `error-${Date.now()}` };
    }
  }

  public static compile({
    content,
    project,
    isHtml,
  }: {
    content: string;
    project: {
      name: string;
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
