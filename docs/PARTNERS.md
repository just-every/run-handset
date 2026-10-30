# Partner handoffs

Signed-in people open **Settings → Partner handoffs** at `/app/partners`.
Choose a service category and select **Find responsible provider**. The result
identifies the responsible product and operator, the information destination and
any unavailable connection. Opening a link is a separate, explicit browser
navigation. It sends no Handset records or credentials and makes no provider API
request from Handset.

| Category | Responsible product and operator | External destination | Availability |
| --- | --- | --- | --- |
| Payroll | Envelope; the independently operated Envelope installation | [Envelope project](https://github.com/just-every/run-envelope) | Project information; no connected payroll installation or purchase account |
| Consumer cellular plan | Separate consumer carrier; the customer's chosen carrier | None configured | Explicitly unavailable; choose and contact a carrier independently |
| Video meeting service | Zoom Workplace; Zoom | [Zoom meeting information](https://www.zoom.com/en/products/virtual-meetings/) | Public information; no connected video account or subscription |
| Enterprise workforce suite | NICE Workforce Management; NICE | [NICE workforce information](https://www.nice.com/products/workforce-management) | Public information; no connected enterprise account or staffing feed |

These are documented category destinations, not claims of a commercial
partnership, provisioned service or qualified partner integration. In particular,
the Envelope project page is not a live payroll installation. No consumer
carrier has been selected on the customer's behalf. Calabrio workforce
forecasting, Genesys and NICE CXone enterprise orchestration, and Google and
Microsoft video services remain separate categories as described in CONTRACT.md.

The matching native-session API is `GET /api/handset/partners` for the catalog
and `POST /api/handset/partners` with a JSON object containing only `category`.
Accepted categories are `payroll`, `consumer-cellular`, `video` and
`enterprise-workforce`. The response contains `handoff` and
`nativeExecution: "none"`; the catalog returns `handoffs` and the same execution
boundary. Unknown categories or fields are refused. A current native session is
required for both UI and API; a POST also requires the installation's same
origin. This information door grants no application-token authority.

Selection is a read-only lookup even when submitted as a POST: it creates no
purchase, subscription, payment, provider request or service-completion record.
Repeating it or restarting Handset does not create an order or a receipt.
External accounts, approval, payment, terms and actual fulfillment stay with the
named product operator. Unavailable destinations have a null destination and an
explicit reason; Handset never substitutes a success message.

Handset retains responsibility for the complete promised SMB phone experience,
failure visibility, queue staffing, QA, lawful predictive dialing and applicable
provider obligations. The normal phone navigation remains available with all
these optional services absent. This information lookup does not qualify
partner-backed numbers, payments or devices, a partner staffing feed, or the
complete call, QA and dialer journeys. Real external receipts need the partners;
no carrier, spend, device, consent or Base hold is released.
