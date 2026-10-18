// Email markup approved in the "Intexa Email Templates" design review.
// Table layout + inline styles so it renders in Gmail, Outlook and Apple Mail.

export const company = {
  name: 'Intexa Group UAB',
  code: '307638275',
  address:
    'Vištyčio g. 43A, Kybartai, LT-70428, Vilkaviškio r. sav., Lithuania',
  email: 'support@intexa-ai.com',
};

/** Version of Terms / Refund Policy attached to order confirmations. Bump together with the PDFs in ./legal. */
export const LEGAL_VERSION = '2026-09-29';
const LEGAL_VERSION_LABEL = '29 September 2026';

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export interface WelcomeData {
  site: string;
  email: string;
  creditBalance: number;
}

export interface OrderData {
  site: string;
  email: string;
  orderId: string;
  date: string;
  withdrawUntil: string;
  plan: string;
  credits: number;
  price: string;
  balance: number;
  method: string;
}

const C = {
  paper: '#f5f3ee',
  card: '#fbfaf6',
  ink: '#20211f',
  muted: '#75766d',
  line: '#ddddd4',
  lime: '#eaff82',
  limeInk: '#242820',
  dark: '#292e24',
  darkMuted: '#b3baa7',
  darkLine: '#444c3b',
  domain: '#858f74',
};
const F = `'Geist',Helvetica,Arial,sans-serif`;
const M = `'Geist Mono',Menlo,Consolas,monospace`;

const esc = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
const num = (value: number) => value.toLocaleString('en-US');

const shell = (preheader: string, inner: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light">
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400&display=swap" rel="stylesheet">
<style>body{margin:0;padding:0;background:${C.paper}}a{color:${C.ink}}@media (max-width:620px){.px{padding-left:22px!important;padding-right:22px!important}.h1{font-size:38px!important;line-height:1.08!important}.stack{display:block!important;width:100%!important}.stack-gap{padding-top:10px!important}.big{font-size:40px!important}}</style></head>
<body style="margin:0;padding:0;background:${C.paper};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${preheader}&#8199;&#65279;&#847;&#8199;&#65279;&#847;&#8199;&#65279;&#847;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.paper};"><tr><td align="center" style="padding:28px 12px 40px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;font-family:${F};color:${C.ink};">
${inner}
</table></td></tr></table></body></html>`;

const topBar = (site: string, label: string) => `<tr><td class="px" style="padding:0 36px 26px;border-bottom:1px solid ${C.line};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
<td style="font-family:${F};font-size:24px;font-weight:650;letter-spacing:-1.3px;color:${C.ink};"><a href="${site}" style="color:${C.ink};text-decoration:none;">intexa-ai<span style="color:${C.domain};font-size:17px;letter-spacing:-.5px;">.com</span></a></td>
<td align="right" style="font-family:${M};font-size:10px;letter-spacing:.9px;color:${C.muted};text-transform:uppercase;"><span style="display:inline-block;width:6px;height:6px;border-radius:6px;background:#c8d86a;vertical-align:middle;margin-right:7px;"></span>${label}</td>
</tr></table></td></tr>`;

const kicker = (t: string) =>
  `<div style="font-family:${M};font-size:10px;letter-spacing:.9px;color:${C.muted};text-transform:uppercase;margin:0 0 18px;">${t}</div>`;
const button = (href: string, text: string) =>
  `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td style="border-radius:50px;background:${C.lime};"><a href="${href}" style="display:inline-block;padding:16px 26px;font-family:${F};font-size:14px;font-weight:600;color:${C.limeInk};text-decoration:none;border-radius:50px;">${text}&nbsp;&nbsp;&nbsp;↗</a></td></tr></table>`;
const p = (t: string) =>
  `<p style="margin:0 0 16px;font-family:${F};font-size:15px;line-height:1.7;color:${C.ink};">${t}</p>`;
const muted = (t: string) =>
  `<p style="margin:0 0 12px;font-family:${F};font-size:13px;line-height:1.7;color:${C.muted};">${t}</p>`;
const h2 = (t: string) =>
  `<h2 style="margin:0 0 12px;font-family:${F};font-size:20px;font-weight:550;letter-spacing:-.5px;color:${C.ink};">${t}</h2>`;
const mailLink = (color = C.ink) =>
  `<a href="mailto:${company.email}" style="color:${color};">${company.email}</a>`;

const footer = (site: string, reason: string) => `<tr><td class="px" style="padding:30px 36px 0;border-top:1px solid ${C.line};">
<p style="margin:0 0 14px;font-family:${F};font-size:12px;line-height:1.8;">
${[
  ['Terms', '/legal/terms'],
  ['Privacy', '/legal/privacy'],
  ['Refunds & withdrawal', '/legal/refunds'],
  ['Acceptable use', '/legal/acceptable-use'],
]
  .map(
    ([t, h]) =>
      `<a href="${site}${h}" style="color:${C.muted};text-decoration:underline;margin-right:14px;">${t}</a>`,
  )
  .join('')}</p>
<p style="margin:0 0 6px;font-family:${F};font-size:12px;line-height:1.7;color:${C.muted};">${company.name} · Company code ${company.code}<br>${company.address}<br>${mailLink(C.muted)}</p>
<p style="margin:14px 0 0;font-family:${M};font-size:9px;letter-spacing:.8px;color:#9a9e90;text-transform:uppercase;">${reason}</p>
</td></tr>`;

const textFooter = (site: string) => `--
${company.name} · Company code ${company.code}
${company.address}
${company.email}
Terms: ${site}/legal/terms · Privacy: ${site}/legal/privacy · Refunds: ${site}/legal/refunds`;

export function welcomeEmail(d: WelcomeData): RenderedEmail {
  const step = (n: string, title: string, text: string) =>
    `<tr><td valign="top" style="padding:14px 0;border-top:1px solid ${C.line};width:44px;font-family:${M};font-size:11px;color:#8b907c;">${n}</td><td style="padding:14px 0;border-top:1px solid ${C.line};"><div style="font-family:${F};font-size:15px;font-weight:600;letter-spacing:-.3px;margin-bottom:3px;">${title}</div><div style="font-family:${F};font-size:13px;line-height:1.6;color:${C.muted};">${text}</div></td></tr>`;
  const html = shell(
    'Your account is ready. Describe an idea and meet your first image or video.',
    `
${topBar(d.site, 'Account created')}
<tr><td class="px" style="padding:44px 36px 8px;">
${kicker('Welcome to the studio')}
<h1 class="h1" style="margin:0 0 22px;font-family:${F};font-size:48px;line-height:1.04;font-weight:500;letter-spacing:-2.6px;color:${C.ink};">Imagine it.<br>Make it <span style="background:${C.lime};padding:0 6px;border-radius:6px;">real.</span></h1>
${p(`Your intexa-ai.com account for <b style="font-weight:600;">${esc(d.email)}</b> is ready. Describe what you want to see, choose a format, and bring the idea in your head into the world.`)}
<div style="height:10px"></div>${button(`${d.site}/dashboard`, 'Open your workspace')}
</td></tr>
<tr><td class="px" style="padding:40px 36px 10px;">
${kicker('Three simple steps')}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0">
${step('01', 'Start with a spark', 'Describe what you want to see. A few words or a detailed vision.')}
${step('02', 'Make it your own', 'Choose image or video, a style and an aspect ratio.')}
${step('03', 'Meet your creation', 'Find your favorite and build on the idea in your next project.')}
</table></td></tr>
<tr><td class="px" style="padding:26px 36px 36px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eceee5;border-radius:12px;"><tr><td style="padding:22px 24px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
<td class="stack" valign="top"><div style="font-family:${M};font-size:10px;letter-spacing:.9px;color:${C.muted};text-transform:uppercase;margin-bottom:8px;">Your credit balance</div><div style="font-family:${F};font-size:34px;font-weight:450;letter-spacing:-1.6px;">${num(d.creditBalance)} <span style="font-size:16px;letter-spacing:0;">credits</span></div></td>
<td class="stack stack-gap" valign="top" style="width:55%;font-family:${F};font-size:13px;line-height:1.65;color:${C.muted};">Credits power every generation: 10 credits per image, video from 10 credits per second. You always see the price before you start. To top up, reply to this email.</td>
</tr></table></td></tr></table>
</td></tr>
<tr><td class="px" style="padding:0 36px 30px;">
${muted(`Didn’t create this account? Write to ${mailLink()} and we’ll close it.`)}
</td></tr>
${footer(d.site, 'You receive this service email because an account was created with this address.')}
`,
  );
  const text = `Imagine it. Make it real.

Your intexa-ai.com account for ${d.email} is ready. Describe what you want to see, choose a format, and bring the idea in your head into the world.

Open your workspace: ${d.site}/dashboard

Three simple steps
01 Start with a spark: describe what you want to see.
02 Make it your own: choose image or video, a style and an aspect ratio.
03 Meet your creation: find your favorite and build on the idea.

Your credit balance: ${num(d.creditBalance)} credits
Credits power every generation: 10 credits per image, video from 10 credits per second. You always see the price before you start. To top up, reply to this email.

Didn’t create this account? Write to ${company.email} and we’ll close it.

${textFooter(d.site)}`;
  return { subject: 'Welcome to intexa-ai.com', html, text };
}

export function orderEmail(d: OrderData): RenderedEmail {
  const credits = num(d.credits);
  const row = (k: string, v: string, strong = false) =>
    `<tr><td style="padding:9px 0;border-top:1px solid ${C.darkLine};font-family:${F};font-size:13px;color:${C.darkMuted};">${k}</td><td align="right" style="padding:9px 0;border-top:1px solid ${C.darkLine};font-family:${F};font-size:13px;color:#f4f6ec;${strong ? 'font-weight:600;' : ''}">${v}</td></tr>`;
  const good = [
    ['Credits don’t expire', 'Purchased credits stay on your balance until you use them.'],
    ['Failed generations are free', 'If a generation fails, its credits return to your balance automatically.'],
    ['Your contract terms', `The Terms of Service and Refund & Withdrawal Policy (version of ${LEGAL_VERSION_LABEL}) are attached to this email.`],
  ];
  const html = shell(
    `${credits} credits added to your balance. Order ${d.orderId}.`,
    `
${topBar(d.site, 'Order confirmation')}
<tr><td class="px" style="padding:44px 36px 6px;">
${kicker(`Order ${d.orderId}`)}
<h1 class="h1" style="margin:0 0 20px;font-family:${F};font-size:48px;line-height:1.04;font-weight:500;letter-spacing:-2.6px;">${credits} credits<br><span style="color:#84877a;">are ready.</span></h1>
${p('Thank you for your purchase. This email confirms your order and is your record of the contract. Please keep it.')}
</td></tr>
<tr><td class="px" style="padding:14px 36px 0;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.dark};border-radius:14px;"><tr><td style="padding:26px 26px 18px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
<td style="font-family:${F};font-size:22px;font-weight:500;letter-spacing:-.8px;color:#f4f6ec;">${esc(d.plan)}</td>
<td align="right"><span style="font-family:${M};font-size:9px;letter-spacing:.6px;color:${C.lime};border:1px solid #eaff8240;background:#eaff821a;border-radius:20px;padding:5px 9px;">PAID</span></td>
</tr></table>
<div class="big" style="font-family:${F};font-size:48px;font-weight:450;letter-spacing:-2.4px;color:#f4f6ec;margin:18px 0 2px;">${d.price}</div>
<div style="font-family:${F};font-size:12px;color:${C.darkMuted};margin-bottom:18px;">One-time credit package · no subscription</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0">
${row('Credits', credits)}
${row('Order date', d.date)}
${row('Payment method', esc(d.method))}
${row('Price', d.price)}
${row('VAT', 'Not charged¹')}
${row('Total paid', d.price, true)}
</table>
<div style="font-family:${F};font-size:11px;line-height:1.6;color:${C.darkMuted};margin-top:12px;">¹ ${company.name} is not registered for VAT.</div>
</td></tr>
<tr><td style="padding:16px 26px;border-top:1px solid ${C.darkLine};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
<td style="font-family:${M};font-size:10px;letter-spacing:.9px;color:${C.darkMuted};text-transform:uppercase;">New balance</td>
<td align="right" style="font-family:${F};font-size:15px;color:${C.lime};font-weight:600;">✧ ${num(d.balance)} credits</td>
</tr></table></td></tr></table>
</td></tr>
<tr><td class="px" style="padding:26px 36px 8px;">${button(`${d.site}/dashboard`, 'Start creating')}</td></tr>

<tr><td class="px" style="padding:34px 36px 6px;">
${h2('Your 14-day right of withdrawal')}
${p(`You can withdraw from this purchase until <b style="font-weight:600;">${d.withdrawUntil}</b> without giving a reason, and we will refund you in full.`)}
${p('If you want to use these credits before that date, we will first ask you to confirm in your workspace that generation can start right away. Credits you then use are no longer refundable under the right of withdrawal. Unused credits always are.')}
${p(`To withdraw, email ${mailLink()} with your order number, or use the model withdrawal form below. We refund within 14 days, to the payment method you used.`)}
</td></tr>

<tr><td class="px" style="padding:10px 36px 6px;">
${h2('Good to know')}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0">
${good.map(([t, text]) => `<tr><td valign="top" style="padding:10px 12px 10px 0;width:16px;color:#7b8a61;font-family:${F};font-size:14px;">✓</td><td style="padding:10px 0;font-family:${F};font-size:13px;line-height:1.6;color:${C.muted};"><b style="color:${C.ink};font-weight:600;">${t}.</b> ${text}</td></tr>`).join('')}
</table></td></tr>

<tr><td class="px" style="padding:22px 36px 34px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px dashed #c9cbbd;border-radius:12px;"><tr><td style="padding:20px 22px;font-family:${F};font-size:12px;line-height:1.75;color:${C.muted};">
<div style="font-family:${M};font-size:10px;letter-spacing:.9px;text-transform:uppercase;margin-bottom:10px;">Model withdrawal form</div>
(Complete and return this form only if you wish to withdraw from the contract.)<br><br>
To: ${company.name}, ${company.address}, ${company.email}<br>
I hereby give notice that I withdraw from my contract for the provision of the following service: credit package ${esc(d.plan)}, order ${d.orderId}<br>
Ordered on: ${d.date.split(',')[0]}<br>
Name of consumer: ______________________<br>
Address of consumer: ______________________<br>
Signature (only if this form is sent on paper): ____________<br>
Date: ____________
</td></tr></table>
</td></tr>
${footer(d.site, 'This email confirms your purchase on a durable medium, as required by EU consumer law.')}
`,
  );
  const text = `Order ${d.orderId}: ${credits} credits are ready.

Thank you for your purchase. This email confirms your order and is your record of the contract. Please keep it.

Package: ${d.plan} (one-time credit package, no subscription)
Credits: ${credits}
Order date: ${d.date}
Payment method: ${d.method}
Price: ${d.price}
VAT: not charged (${company.name} is not registered for VAT)
Total paid: ${d.price}
New balance: ${num(d.balance)} credits

Start creating: ${d.site}/dashboard

YOUR 14-DAY RIGHT OF WITHDRAWAL
You can withdraw from this purchase until ${d.withdrawUntil} without giving a reason, and we will refund you in full.
If you want to use these credits before that date, we will first ask you to confirm in your workspace that generation can start right away. Credits you then use are no longer refundable under the right of withdrawal. Unused credits always are.
To withdraw, email ${company.email} with your order number, or use the model withdrawal form below. We refund within 14 days, to the payment method you used.

GOOD TO KNOW
- ${good.map(([t, text]) => `${t}. ${text}`).join('\n- ')}

MODEL WITHDRAWAL FORM
(Complete and return this form only if you wish to withdraw from the contract.)
To: ${company.name}, ${company.address}, ${company.email}
I hereby give notice that I withdraw from my contract for the provision of the following service: credit package ${d.plan}, order ${d.orderId}
Ordered on: ${d.date.split(',')[0]}
Name of consumer:
Address of consumer:
Signature (only if this form is sent on paper):
Date:

${textFooter(d.site)}`;
  return {
    subject: `Order ${d.orderId} confirmed: ${credits} credits`,
    html,
    text,
  };
}
