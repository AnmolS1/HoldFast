import { defineMessages } from "../../lib/i18n";

// The elements follow 17 U.S.C. §512(c)(3)(A) and §512(g)(3) (Cornell LII, read 2026-10-22), in the
// statute's order. They describe the law and what Holdfast does; they are not legal advice.
export const messages = {
  "dmca.title": "Copyright and DMCA",
  "dmca.intro":
    "Holdfast respects copyright. If you believe a file stored or shared on Holdfast infringes your copyright, send a notice to our designated agent. We respond to notices under the Digital Millennium Copyright Act (17 U.S.C. §512).",

  "dmca.agent.title": "Designated agent",
  "dmca.agent.lead": "Send notices and counter-notices to:",
  // Shown instead of the details while agent.ts still carries the sentinel (agent.ts).
  "dmca.agent.pending": "Designated agent registration pending.",
  "dmca.agent.name": "Name",
  "dmca.agent.address": "Address",
  "dmca.agent.phone": "Phone",
  "dmca.agent.email": "Email",

  "dmca.notice.title": "Sending a notice",
  "dmca.notice.lead": "A notice must be in writing and include:",
  "dmca.notice.signature":
    "A physical or electronic signature of a person authorised to act for the owner of the copyright.",
  "dmca.notice.work":
    "Identification of the copyrighted work you say is infringed (or, for several works, a representative list).",
  "dmca.notice.material":
    "Identification of the material you say is infringing, with enough information for us to find it — for example the share link.",
  "dmca.notice.contact":
    "Your contact details: postal address, telephone number and, if you have one, an email address.",
  "dmca.notice.goodFaith":
    "A statement that you have a good-faith belief that the use is not authorised by the copyright owner, its agent or the law.",
  "dmca.notice.accuracy":
    "A statement that the information in the notice is accurate and, under penalty of perjury, that you are authorised to act for the copyright owner.",
  "dmca.notice.after":
    "When a notice is complete we disable access to the material, pause its share links and tell the account owner, with a copy of the notice's description of the material.",

  "dmca.counter.title": "Counter-notice",
  "dmca.counter.lead":
    "If your file was taken down and you believe that happened by mistake or misidentification, you can send a counter-notice to the designated agent. It must include:",
  "dmca.counter.signature": "Your physical or electronic signature.",
  "dmca.counter.material":
    "Identification of the material that was taken down and where it appeared before it was taken down (its name and folder, or its share link).",
  "dmca.counter.statement":
    "A statement under penalty of perjury that you have a good-faith belief that the material was taken down as a result of mistake or misidentification.",
  "dmca.counter.identity":
    "Your name, address and telephone number, and a statement that you consent to the jurisdiction of the Federal District Court for the judicial district of your address (or, outside the United States, any judicial district in which Holdfast may be found), and that you will accept service of process from the person who sent the notice or their agent.",
  "dmca.counter.after":
    "We send a copy of the counter-notice — including your name and address — to the person who sent the notice. Unless that person tells our designated agent that they have filed a court action against you about the material, we restore it not less than 10 and not more than 14 business days after we receive the counter-notice.",

  "dmca.repeat.title": "Repeat infringers",
  "dmca.repeat.body":
    "Each copyright notice we act on gives one strike to the person who uploaded the file. Strikes for malware and abuse count too. An account with {strikes} strikes within {days} days is suspended: it is signed out everywhere and its share links stop working. A strike is lifted when the material is restored after a counter-notice or the notice is withdrawn.",

  "dmca.false.title": "False claims",
  "dmca.false.body":
    "Anyone who knowingly and materially misrepresents that material is infringing, or that it was taken down by mistake, may be liable for damages, including costs and attorneys' fees (17 U.S.C. §512(f)). If you are unsure whether your use is allowed, consider asking a lawyer before sending a notice or counter-notice.",
} as const;

export const t = defineMessages(messages);
