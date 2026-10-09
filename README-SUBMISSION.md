# Submission - Hassan Rehman

I read the code first to understand the five route files, then ran the API and tested each endpoint with curl: happy path, invalid input, security (forged signatures, tampered bodies, type confusion) and duplicates. That confirmed the 7 seeded bugs (A-G) and turned up five more: the seeded login that never works, an unauthenticated e-invoice webhook, malformed JSON giving a 500, case-sensitive emails, and unvalidated table-order items. Each fix is small, commented and keeps the existing response shapes. I wrote 53 automated tests with the Node test runner (`npm test`) and checked that they fail on the original code and pass on the fixed code. Details are in `bug-reports.md`, `fixes.md` and `test-plan.md`; a Postman collection with test assertions is in `postman/`. A few risky items (unauthenticated table-order creation, hard-coded secrets, no rate limit, no replay window) are documented but not changed because they would alter the API contract.

Run it:

```bash
npm install
npm test      # 53 tests
npm start
```
