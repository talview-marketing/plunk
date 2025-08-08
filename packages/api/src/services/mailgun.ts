import Mailgun from "mailgun.js";
import formData from "form-data";
import { MAILGUN_API_KEY, MAILGUN_DOMAIN } from "../app/constants";

// Create a mock client if Mailgun is not configured
let mgClient: any;
let DOMAIN: string | undefined;

try {
  if (!MAILGUN_API_KEY || !MAILGUN_DOMAIN) {
    console.warn("Mailgun environment variables not set, using mock client");
    mgClient = {
      messages: {
        create: async () => ({ id: `mock-${Date.now()}` })
      },
      domains: {
        get: async () => ({ status: "unverified" }),
        create: async () => ({ dkim_selector: "mock-selector" })
      }
    };
    DOMAIN = "mock-domain";
  } else {
    mgClient = new Mailgun(formData).client({
      username: "api",
      key: MAILGUN_API_KEY,
    });
    DOMAIN = MAILGUN_DOMAIN;
  }
} catch (error) {
  console.error("Failed to initialize Mailgun client:", error);

  mgClient = {
    messages: {
      create: async () => ({ id: `mock-${Date.now()}` })
    },
    domains: {
      get: async () => ({ status: "unverified" }),
      create: async () => ({ dkim_selector: "mock-selector" })
    }
  };
  DOMAIN = "mock-domain";
}

export { mgClient };
export { DOMAIN };

