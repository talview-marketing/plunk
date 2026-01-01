
import Mailgun from "mailgun.js";
import formData from "form-data";
import { MAILGUN_API_KEY, MAILGUN_DOMAIN } from "../app/constants";

if (!MAILGUN_API_KEY || !MAILGUN_DOMAIN) {
  throw new Error(
    "Mailgun configuration missing: MAILGUN_API_KEY and MAILGUN_DOMAIN environment variables are required"
  );
}

const mgClient = new Mailgun(formData).client({
  username: "api",
  key: MAILGUN_API_KEY,
  url: 'https://api.eu.mailgun.net'
});

const DOMAIN = MAILGUN_DOMAIN;

export { mgClient, DOMAIN };