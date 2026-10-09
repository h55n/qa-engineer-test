# The EU Pay API Bug Guide

*By Hassan Rehman. A plain-language tour of every bug I found, what it could have cost, and how I fixed it.*

The API is a small payment system: merchants log in, take payments, receive messages from a payment provider, run restaurant table orders and send invoices to the tax office. I found **20 bugs**. Seven were planted on purpose (A to G), thirteen I found on my own (H to T). All 20 are fixed and each one has a test that fails on the old code and passes on the new.

The short version: the app trusted everyone too easily, did things twice, and believed whatever it was told.

---

## 1. Open doors: anyone could walk in (security)

Think of a shop where the back door has no lock and the cashier hands over the till to anyone who says "I'm from head office".

| Bug | What was wrong | What could happen |
| --- | -------------- | ----------------- |
| **D** Fake payment messages (Critical) | The payment provider sends the shop a message like "payment 1 is paid". The app never checked the sender's signature, so anyone could send one. | A cheater marks their own unpaid order as "completed" and walks out with the goods. |
| **I** Same hole for invoices | The tax-office message endpoint had no check at all. | Someone rewrites an invoice as "rejected" or "accepted". |
| **O** Eavesdropping on live orders (High) | Live order updates run over sockets. Any visitor could say "I'm merchant 1" and watch that merchant's orders, customer names included. | A competitor sees every order in real time. |
| **P** Tables shared between shops | The live "table 5" channel was shared by every merchant, so two different restaurants with a table 5 got each other's updates. | One restaurant's kitchen screen shows another's orders. |

**Fix:** every message from the provider must carry a secret signature (HMAC) that I verify against the exact bytes received, using a comparison that does not leak timing hints. Sockets now carry the merchant's login token and can only join their own rooms.

## 2. Login and account trouble

| Bug | What was wrong | Why it matters |
| --- | -------------- | -------------- |
| **H** The demo login never worked | The saved password for the test merchant was not a real hash, so the README's own login example failed. | Nobody could test anything with the seeded account. |
| **K** Upper and lower case | `QA@test.com` and `qa@test.com` became two accounts. | Duplicate accounts and "I can't log in" mysteries. |
| **S** Long passwords get chopped | The hashing tool only reads the first 72 characters. A longer password was silently cut. | Two different passwords could open the same account. |
| **C** Fake-looking emails | `user@domain` (no `.com`) was accepted. | Mail to these addresses bounces forever. |

**Fix:** a real hash for the demo account, emails lower-cased, passwords capped at 72 bytes with a clear error, and a proper email check that needs a real ending like `.com`.

## 3. Doing things twice (duplicates)

Like a vending machine that takes your coin, gives you a snack, and when you press the button again gives a second snack for free.

| Bug | What was wrong | What could happen |
| --- | -------------- | ----------------- |
| **E** Repeated webhooks | Providers resend messages when unsure. The app applied each one again, so an old "completed" could overwrite a newer "refunded". | A refunded payment shows as paid again. |
| **F** Two orders, one table | Pressing "send" twice created two kitchen tickets. | Double food, double bill. |
| **G** Invoice sent twice | The same invoice went to the tax office twice, and the first receipt number was lost. | Compliance trouble. |
| **M** `1` is not `"1"` | A merchant id sent as a number slipped past the duplicate check and then vanished from the order list. | Ghost orders. |
| **Q** Sneaky invoice id | An invoice id sent as an object instead of text never matched, so it could be submitted forever. | The duplicate rule could be dodged. |

**Fix:** remember every event id and answer "already done" the second time; one open order per table; one submission per invoice; ids are always treated as plain text.

## 4. Garbage in, garbage out (input checks)

Like a ticket machine that accepts a banana as payment.

| Bug | What was wrong | Example |
| --- | -------------- | ------- |
| **B** No upper limit (High) | A payment of 999,999,999 euro was accepted. `Infinity` and `true` also got in and became `null`. | One typo and the books are wrong. |
| **T** Strange numbers | `"0x10"` became 16 euro and `"1e1"` became 10. | Odd text turning into money. |
| **L** Negative prices | An order with a price of -5 gave a total of -5. | Free food with a "refund". |
| **N** Odd table fields | A table number could be an object, an order type could be "teleport". | Strange data on the kitchen screen. |
| **R** Any invoice status | The tax webhook stored any text, including HTML. | "pwned" shown as a status. |
| **J** Broken JSON becomes a crash | Malformed JSON gave a 500 "server error". | Looks like our bug when it is the sender's. |

**Fix:** every field is checked for type, size and allowed values before anything is saved. Amounts are capped at 50,000 with at most two decimals, and bad JSON now gets a clean 400.

## 5. Quietly wrong (logic and format)

| Bug | What was wrong | Why it matters |
| --- | -------------- | -------------- |
| **A** Money as text | Amounts came back as `"25.5"` (text) instead of `25.5` (number). | Screens add `"25.5" + 10` and get `"25.510"`. |
| **L** Silent live updates | The "new order" and "status changed" events were promised but never sent. | Kitchen screens never updated. |

**Fix:** return real numbers, and actually send the events.

---

## Bonus: the tests could not even run

`npm test` pointed at a file pattern that matched nothing in most shells. I fixed the script so the tests run on Node 20 and 22.

## How I know it works

- 63 automated tests, all green. I also ran them against the original buggy code to prove they fail there.
- A Postman collection (31 requests, 32 checks) that signs its own webhooks.
- A written test plan for the webhook flow with 19 scenarios and a risk table.

---

## Suggested improvements (not done, on purpose)

I left these out because they change how the API behaves or need real infrastructure. Each is one line of "why".

**Security**
- **Require login on `POST /api/table-orders`** and take the merchant from the token. Today anyone can create orders for any merchant.
- **Rate limit login, register and webhooks.** Stops password guessing and flooding.
- **Add a timestamp to webhook signatures** and reject anything older than about five minutes. A captured message cannot be replayed later.
- **Load secrets from the environment only**, with no default values. A leaked default is a leaked key.
- **Restrict CORS to known sites** (it currently allows everyone).
- **Return 404 instead of 403 for other merchants' records.** It stops people learning which ids exist.
- **Use the same error time for unknown emails on login.** Right now a missing user is answered faster than a wrong password.
- **Add `helmet` for standard security headers.**

**Correctness**
- **Add a status state machine** (for example refunded can never go back to completed; served orders stay served).
- **Store money as whole cents** to avoid floating-point errors.
- **Check the SIRET with the Luhn check**, not just "14 digits".
- **Event ids on the e-invoice webhook**, like the payment one.
- **Scope idempotency keys per provider** and keep them for a set time.

**Structure and tools**
- **Persist data** (PostgreSQL) with unique constraints; today everything vanishes on restart and a unique index is the only truly race-proof duplicate guard.
- **Separate the app from the server start** (`app.js` / `server.js`) so tests need no tricks.
- **Use one validation library** (zod or joi) instead of hand-written checks.
- **A structured logger** (pino) with request ids, and no stack traces in client responses.
- **GitHub Actions** to run `npm test` on every pull request.
- **Add ESLint and Prettier**, plus an `.env.example`.
- **An OpenAPI file** so the Postman collection and docs come from one source.
- **A failing-webhook retry queue and a daily reconciliation job** against the provider's records.
