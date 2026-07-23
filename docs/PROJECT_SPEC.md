# Rush Tracker

## Master Project Specification

**Document:** `docs/PROJECT_SPEC.md`
**Project:** Rush Tracker
**Application Type:** Full-Stack Multi-Client Ad Account Limit, Billing, Due & Payment Management System
**Status:** Source of Truth for Implementation

> **NOTE (added by Claude, 2026-07-23):** This copy was reconstructed from the project owner's
> message, which was truncated by a transfer limit partway through **Section 85 (Testing
> Requirements)**. Everything up to that point is verbatim. Please replace this file with the
> full original document so no requirements after Section 85 are lost.

---

# 1. Purpose of This Document

This document is the primary source of truth for building **Rush Tracker**.

Before implementing or modifying the application, read this document completely.

If implementation details conflict with this specification, this specification takes priority unless the project owner explicitly approves a change.

Do not silently change:

* the required technology stack
* financial rules
* limit calculation rules
* client due calculation rules
* ad account assignment behavior
* approval workflows
* audit requirements
* authorization boundaries

If a requirement is unclear or technically conflicting, report it before making an assumption that affects financial data or security.

---

# 2. Product Overview

Rush Tracker is an internal and client-facing management system for an agency that manages multiple advertising accounts for multiple clients.

A client may use multiple ad accounts.

The agency manually changes the spending limit of those ad accounts outside Rush Tracker.

Rush Tracker does **not** automatically change Meta or advertising platform spending limits.

Rush Tracker is responsible for tracking:

* Clients
* Ad Accounts
* Ad Account Assignments
* Opening Balances
* Current Spending Limits
* Client Limit Requests
* Admin Limit Approvals
* Limit Update Proofs
* USD to BDT Billing Rates
* Client Billing
* Client-Level Due
* Payment Requests
* Partial and Full Payments
* Payment Proofs
* Payment Verification
* Financial Ledger
* Adjustments and Reversals
* Account Transfers
* Assignment History
* Notifications
* Audit Logs
* Reports

The main operational hierarchy is:

```text
Client
  ↓
Assigned Ad Accounts
  ↓
Limit Requests
  ↓
Admin Approval
  ↓
Manual External Limit Update
  ↓
Proof Upload
  ↓
Approved USD Amount
  ↓
BDT Billing
  ↓
Client-Level Due
  ↓
Payment
  ↓
Admin Verification
  ↓
Ledger Update
```

---

# 3. Required Technology Stack

The application must use the following stack.

## 3.1 Full-Stack Framework

* TanStack Start
* TanStack Router
* React
* TypeScript

TanStack Start must handle server-side application logic.

Do not replace TanStack Start with:

* Next.js
* Express as the primary application framework
* NestJS
* Laravel
* another full-stack framework

unless explicitly approved.

---

## 3.2 Backend Infrastructure

Use Supabase for:

* PostgreSQL Database
* Authentication
* File Storage

Supabase is the persistent backend infrastructure.

Business logic must not be implemented only through direct browser-to-database operations.

Sensitive operations must pass through the TanStack Start server layer.

---

## 3.3 UI

Use:

* Tailwind CSS
* shadcn/ui
* Lucide Icons

The application should have a clean SaaS-style dashboard interface.

Admin UI should be optimized primarily for desktop use.

Client UI must be fully responsive for desktop, tablet, and mobile.

---

## 3.4 Validation and Forms

Use:

* Zod
* React Hook Form where appropriate

All mutations must be validated server-side.

Frontend validation is for user experience only and must never be treated as the security boundary.

---

## 3.5 Data Fetching

Use TanStack Start server functions for business operations.

TanStack Query may be used where appropriate for:

* caching
* invalidation
* client-side asynchronous state
* mutations
* dashboard refreshes

Do not create unnecessary client-side fetching when server loaders are more appropriate.

---

## 3.6 Deployment

Deployment target:

* Vercel
* Vercel Serverless Functions
* Nitro configuration compatible with the chosen TanStack Start version

The implementation must remain compatible with serverless execution.

Do not depend on:

* persistent local filesystem
* long-running server processes
* in-memory global state for business-critical data
* server-local sessions
* assumptions that one server instance handles all requests

---

# 4. High-Level Architecture

```text
Browser
   │
   ▼
TanStack Router / React UI
   │
   ▼
TanStack Start
   │
   ├── Authentication Validation
   ├── Authorization / RBAC
   ├── Zod Validation
   ├── Business Logic
   ├── Financial Calculations
   ├── Supabase Queries
   ├── PostgreSQL RPC Calls
   ├── Storage Access
   ├── Notification Creation
   └── Audit Logging
          │
          ▼
       Supabase
   ┌──────┼─────────┐
   ▼      ▼         ▼
Postgres Auth     Storage
```

Sensitive business operations must follow:

```text
Browser
  ↓
TanStack Start Server Function
  ↓
Authenticate
  ↓
Authorize
  ↓
Validate
  ↓
Execute Business Logic
  ↓
Supabase/PostgreSQL
  ↓
Audit
  ↓
Return Safe Response
```

---

# 5. Architectural Security Rule

The browser must never be trusted for:

* financial calculations
* approved amounts
* approved USD rates
* due balances
* current limit calculations
* account ownership
* role permissions
* payment approval
* limit approval
* account transfer authorization

All such values must be validated or recalculated server-side.

Supabase browser usage may be allowed for legitimate authentication/session functionality.

Business-critical database mutations must be handled through TanStack Start server-side logic.

---

# 6. User Roles

Initial roles:

```text
SUPER_ADMIN
ADMIN
CLIENT
```

The architecture should allow future roles without major database redesign.

---

# 7. Super Admin Permissions

Super Admin has full system access.

Capabilities include:

* View dashboard
* Create/edit/deactivate clients
* Create/edit ad accounts
* Rename ad accounts
* Activate/deactivate ad accounts
* Assign ad accounts
* Transfer ad accounts
* Release ad accounts
* Review limit requests
* Edit approved limit amount
* Edit USD rate during approval
* Approve/reject limit requests
* View and verify proofs
* View client balances
* Create payment requests
* Approve/reject payments
* Create financial adjustments
* Create reversals
* Manage default USD rate
* Manage admin users
* Manage roles/permissions
* View reports
* View audit logs
* Manage system settings

---

# 8. Admin Permissions

ADMIN must support permission-based access.

Example permission keys:

```text
dashboard.view

clients.view
clients.manage

ad_accounts.view
ad_accounts.manage
ad_accounts.assign
ad_accounts.transfer

limit_requests.view
limit_requests.approve

payments.view
payments.approve
payment_requests.create

ledger.view

adjustments.view
adjustments.create

reports.view

exchange_rate.manage

users.view
users.manage

audit_logs.view
```

Sensitive permissions should not automatically belong to every admin.

Examples:

```text
adjustments.create
exchange_rate.manage
users.manage
```

Authorization must always be enforced server-side.

---

# 9. Client Permissions

A CLIENT can only access data belonging to their own client organization.

Client capabilities:

* View dashboard
* View assigned ad accounts
* View account current limits
* Submit limit requests
* View limit request history
* View approval proofs
* View total billing
* View current due
* Submit full or partial payments
* Upload payment proof
* View payment requests from admin
* View payment history
* View client statement/ledger
* View notifications
* Manage allowed profile information

A client must never access another client's:

* ad accounts
* requests
* payments
* proof files
* ledger
* balance
* notifications
* profile information

---

# 10. Core Domain Entities

The core system entities are:

```text
User
Role
Permission
RolePermission

Client
ClientMembership

AdAccount
AdAccountAssignment

LimitRequest

ExchangeRate

LedgerEntry

PaymentRequest
Payment

Adjustment

Attachment

Notification

AuditLog

SystemSetting
```

Exact schema may be refined during implementation, but the domain behavior defined here must remain unchanged.

---

# 11. Client Model

Suggested fields:

```text
clients

id
client_code
name
company_name
email
phone
address
status

created_at
updated_at
```

Suggested statuses:

```text
ACTIVE
INACTIVE
SUSPENDED
```

Example client codes:

```text
CL-0001
CL-0002
CL-0003
```

Use internal UUIDs as primary identifiers.

Human-readable codes are separate from internal IDs.

---

# 12. Client Membership

Do not permanently assume one login equals one client.

Use a membership relationship so future support for multiple users under one client is possible.

Concept:

```text
User
  ↓
ClientMembership
  ↓
Client
```

Suggested fields:

```text
client_memberships

id
user_id
client_id
status
created_at
```

Only active memberships grant access.

---

# 13. Ad Account Model

Suggested fields:

```text
ad_accounts

id
account_code
name
external_account_id
platform
status
current_limit_usd

created_at
updated_at
```

Example:

```text
Account Code:
ADA-0001

Name:
XR Meta Account 01

External Account ID:
123456789

Platform:
META

Current Limit:
1100.00 USD
```

Suggested statuses:

```text
AVAILABLE
ACTIVE
INACTIVE
SUSPENDED
```

`name` must be editable.

Internal `id` must never change.

`account_code` should normally remain stable after creation.

Renaming an account must not break historical records.

---

# 14. Ad Account Assignment Model

An ad account can move between clients over time.

Do not store only:

```text
ad_accounts.client_id
```

as the sole ownership model.

Use assignment history.

Suggested entity:

```text
ad_account_assignments

id
ad_account_id
client_id

opening_limit_usd
closing_limit_usd

assigned_at
released_at

status

assigned_by
released_by

notes

created_at
updated_at
```

Suggested statuses:

```text
ACTIVE
RELEASED
```

Business constraint:

```text
One Ad Account can have only one ACTIVE assignment at a time.
```

This constraint must be protected at the database level where possible.

---

# 15. Account Assignment Logic

When an ad account is assigned to a client:

```text
Assignment Opening Limit
=
Ad Account Current Limit
```

Example:

```text
Ad Account Current Limit:
$800

Assigned to Client 01

Client 01 Assignment Opening Limit:
$800
```

This opening limit does not create any client due.

It represents usage that existed before the client started using the account.

---

# 16. Account Transfer Logic

Example:

```text
ADA 04
Current Client: Client 01
Current Limit: $1100
```

Admin transfers it to Client 02.

The system must:

1. Close Client 01's active assignment.
2. Set:

```text
closing_limit_usd = $1100
released_at = current timestamp
status = RELEASED
```

3. Create a new assignment for Client 02:

```text
opening_limit_usd = $1100
status = ACTIVE
```

Client 02 begins from:

```text
$1100
```

Client 02 does not owe anything for that $1100.

Only new limits approved after Client 02 receives the account create Client 02 billing.

Transfer history must remain permanent.

---

# 17. Account Release

Admin must be able to release an ad account without immediately assigning it to another client.

When released:

* active assignment closes
* closing limit is stored
* account becomes AVAILABLE or appropriate status
* history remains intact

Later assignment uses the account's latest current limit as the new opening limit.

---

# 18. Account Rename

Admin can rename an ad account.

Example:

```text
Old:
ADA 04

New:
XR-META-04
```

Historical requests, ledger references, assignments, and proofs must continue referencing the same immutable ad account ID.

---

# 19. Active / Inactive Account Behavior

If a client is actively using an assigned account:

```text
ACTIVE
```

If they stop using it:

```text
INACTIVE
```

Inactive accounts cannot receive new client limit requests.

Historical information must remain accessible.

Changing status must never delete historical records.

---

# 20. Opening Balance and Current Limit Logic

This is a critical business rule.

For every new limit request:

```text
Opening Balance
=
Current Ad Account Limit at the request baseline
```

Example 1:

```text
Opening Balance:
$0

Requested:
$400

Approved:
$400

New Current Limit:
$400
```

Next request:

```text
Opening Balance:
$400

Requested:
$200

Approved:
$200

New Current Limit:
$600
```

Next request:

```text
Opening Balance:
$600

Requested:
$300

Approved:
$250

New Current Limit:
$850
```

Formula:

```text
New Current Limit
=
Opening Balance
+
Approved Amount
```

Each limit request must store its opening balance as a historical snapshot.

Do not dynamically recalculate old request opening balances.

---

# 21. Limit Request Workflow

Client sees an active assigned account.

Example:

```text
Ad Account:
ADA 01

Current Limit:
$600

Required Amount:
[ $________ ]

Expected New Limit:
$800

[ Request Limit ]
```

Client enters:

```text
Requested Amount:
$200
```

System displays:

```text
Opening Balance:
$600

Requested:
$200

Expected New Limit:
$800
```

On submission:

```text
status = PENDING
```

At this stage:

* current limit does not change
* client due does not change
* ledger does not receive a billing entry

---

# 22. Limit Request Model

Suggested fields:

```text
limit_requests

id
request_number

client_id
ad_account_id
assignment_id

opening_balance_usd

requested_amount_usd
approved_amount_usd

default_usd_rate
approved_usd_rate

expected_new_limit_usd
approved_new_limit_usd

bdt_charge

status

requested_by
reviewed_by

requested_at
reviewed_at
approved_at
rejected_at
cancelled_at

admin_note
rejection_reason

created_at
updated_at
```

Suggested statuses:

```text
PENDING
APPROVED
REJECTED
CANCELLED
```

---

# 23. Limit Request Number

Generate a human-readable unique request number.

Example:

```text
LR-000001
LR-000002
```

Internal primary key remains UUID.

Do not use sequential public numbers as authorization identifiers.

---

# 24. One Pending Request Per Account

Recommended V1 business rule:

```text
An Ad Account may have at most one PENDING limit request at a time.
```

A client cannot submit another request for the same account until the existing request becomes:

```text
APPROVED
REJECTED
CANCELLED
```

Enforce this server-side and, where practical, with a database constraint/index.

---

# 25. Admin Limit Approval

Admin opens a pending request.

Example interface:

```text
Limit Request: LR-000124

Client:
Client 01

Ad Account:
ADA 01

Opening Balance:
$600

Requested Amount:
$300

Approved Amount:
[ $300 ]

USD Rate:
[ ৳145 ]

New Current Limit:
$900

Client Charge:
৳43,500

Proof:
[ Upload Screenshot ]

Admin Note:
[................]

[ Reject ]
[ Approve ]
```

Admin may edit:

```text
Approved Amount
USD Rate
```

Admin may approve less or more than the originally requested amount if business policy permits.

The final approved amount is the amount that affects:

* ad account current limit
* USD limit purchased
* BDT billing
* ledger

---

# 26. Editable USD Rate During Approval

The system must have a default USD rate.

Example:

```text
Default USD Rate:
৳145
```

When Admin opens a limit approval form:

```text
USD Rate:
[145]
```

The field is prefilled using the current default rate.

Authorized admin may edit it before approval.

Example:

```text
Default:
৳145

Approval Rate:
৳147
```

The final approved rate must be stored as an immutable snapshot for that approved transaction.

Changing the default rate later must not alter previous transactions.

---

# 27. Exchange Rate Model

Suggested fields:

```text
exchange_rates

id
rate
effective_from
changed_by
created_at
```

System settings may also store the current default rate reference.

Maintain historical rate changes.

Changing the default rate must create an audit log.

---

# 28. Limit Approval Calculation

Example:

```text
Opening Balance:
$600

Requested:
$300

Admin Approved:
$250

Approved USD Rate:
৳147
```

Calculate server-side:

```text
New Current Limit:
$600 + $250
= $850
```

Billing:

```text
BDT Charge:
$250 × ৳147
= ৳36,750
```

Final approved snapshot:

```text
Opening Balance:
$600

Requested:
$300

Approved:
$250

Applied USD Rate:
৳147

New Current Limit:
$850

BDT Charge:
৳36,750
```

---

# 29. Limit Approval Proof

Admin must upload proof of the external/manual spending limit update before final approval.

Proof may be:

* JPG
* JPEG
* PNG
* WEBP
* PDF if enabled

Approval must fail if required proof is missing.

The client must be able to view the approved proof for their own request.

---

# 30. Stale Opening Balance Protection

This is mandatory.

Suppose:

```text
Request Created With:
Opening Balance = $500
```

Before approval, actual account current limit somehow becomes:

```text
$700
```

The system must not blindly approve using stale `$500`.

Before final approval, compare:

```text
request.opening_balance_usd
vs
ad_account.current_limit_usd
```

If different:

```text
CONFLICT
```

Do not approve automatically.

Admin must be informed that the baseline changed.

Example message:

```text
The current limit has changed since this request was created.

Request Opening Balance:
$500

Actual Current Limit:
$700
```

The system must provide a controlled resolution flow.

Recommended V1 behavior:

* block approval
* allow authorized admin to refresh/rebase the pending request baseline
* recalculate expected new limit
* audit the rebase action
* then continue approval

Never silently rebase financial/operational values.

---

# 31. Atomic Limit Approval

Limit approval is a business-critical operation and must be atomic.

Do not implement approval as independent non-transactional database updates.

Recommended approach:

TanStack Start server function:

1. Authenticate.
2. Check permission.
3. Validate input with Zod.
4. Verify proof.
5. Call a PostgreSQL RPC/database function.
6. Database operation performs the critical transaction atomically.

Conceptual transaction:

```text
BEGIN

Lock pending Limit Request

Verify:
status = PENDING

Lock relevant Ad Account / Assignment

Verify:
assignment is active
client matches
account is eligible
opening balance matches current limit

Calculate:
approved new limit
BDT charge

Update Limit Request

Update Ad Account current limit

Create Ledger Entry

Create required financial reference

Mark request APPROVED

Create relevant audit data

COMMIT
```

If any step fails:

```text
ROLLBACK
```

Notification creation may occur immediately after successful transaction if it is not included inside the database transaction.

---

# 32. PostgreSQL RPC Functions

Business-critical multi-write operations should use PostgreSQL functions/RPC where atomicity is required.

Expected operations include:

```text
approve_limit_request(...)
approve_payment(...)
transfer_ad_account(...)
create_adjustment(...)
reverse_financial_transaction(...)
rebase_limit_request(...)
```

Exact signatures should be designed during database implementation.

Do not place authorization solely inside RPC.

TanStack Start server-side authorization remains mandatory.

Database constraints and RPC validation provide additional protection.

---

# 33. Financial Model

Rush Tracker has two separate financial/operational concepts.

## Operational USD

Tracks:

* current ad account spending limit
* approved USD limit additions
* total USD limit purchased

## Financial BDT

Tracks:

* billed BDT
* payments
* outstanding due
* adjustments
* reversals

These must not be mixed.

Example:

```text
Ad Account Current Limit:
$1100

Client Assignment Started At:
$800

Client Approved New Limit:
$300

USD Rate:
৳145

Client Billing:
৳43,500
```

The client does not owe for the initial $800.

---

# 34. Client-Level Due

Due is maintained at client level.

It is not primarily an individual ad account payment balance.

A client's multiple ad account approvals contribute to one overall client financial balance.

Example:

```text
ADA 01 approved:
$400 @ ৳145
= ৳58,000

ADA 02 approved:
$200 @ ৳147
= ৳29,400

Total Billed:
৳87,400
```

Client pays:

```text
৳50,000
```

Remaining client due:

```text
৳37,400
```

---

# 35. Source of Truth for Due

The financial ledger is the source of truth.

Do not maintain a manually editable `current_due` field as the authoritative financial value.

Conceptually:

```text
Current Due
=
Total Debit
-
Total Credit
```

Where appropriate, optimized cached/materialized values may be introduced later, but they must always be reconcilable against the immutable ledger.

---

# 36. Ledger Model

Suggested fields:

```text
ledger_entries

id
transaction_number

client_id

type

reference_type
reference_id

usd_amount
usd_rate
bdt_amount

debit_bdt
credit_bdt

description

created_by
created_at
```

Avoid storing a mutable `balance_after` unless implementation guarantees strict correctness under concurrency.

The authoritative balance should be derivable from ledger entries.

Suggested types:

```text
LIMIT_APPROVAL
PAYMENT
ADJUSTMENT_DEBIT
ADJUSTMENT_CREDIT
REVERSAL
```

---

# 37. Ledger Examples

Limit approval:

```text
Transaction:
TXN-000001

Type:
LIMIT_APPROVAL

USD:
$400

Rate:
৳145

Debit:
৳58,000

Credit:
৳0
```

Second approval:

```text
USD:
$200

Rate:
৳147

Debit:
৳29,400
```

Total due:

```text
৳87,400
```

Payment:

```text
Type:
PAYMENT

Debit:
৳0

Credit:
৳50,000
```

Remaining due:

```text
৳37,400
```

---

# 38. Money Data Types

Never use JavaScript floating-point arithmetic as the authoritative financial calculation method.

Database monetary fields should use PostgreSQL:

```text
NUMERIC / DECIMAL
```

Recommended:

```text
USD Amount:
NUMERIC(18,2)

BDT Amount:
NUMERIC(18,2)

USD Rate:
NUMERIC(18,4)
```

Server-side calculations must use a decimal-safe strategy.

Never trust frontend-calculated totals.

Always recalculate server-side.

---

# 39. Approved Financial Records

Approved financial records must not be directly edited or deleted.

This includes:

* approved limit billing
* approved payment credits
* approved adjustments
* reversals

Corrections must use:

```text
Adjustment
or
Reversal
```

This preserves auditability.

---

# 40. Adjustment System

Authorized admins must be able to create financial adjustments.

Suggested adjustment types:

```text
ADD_DUE
REDUCE_DUE
REVERSAL
```

Suggested fields:

```text
adjustments

id
adjustment_number
client_id

type

amount_bdt

reference_type
reference_id

reason
internal_note

created_by
created_at
```

Adjustment creation must create a corresponding ledger entry.

Example:

Incorrect billing:

```text
Original:
৳43,500

Correct:
৳36,750

Difference:
৳6,750
```

Create:

```text
ADJUSTMENT_CREDIT:
৳6,750
```

Original transaction remains unchanged.

---

# 41. Reversal

Reversal should reference the original transaction.

A reversal must:

* never delete the original
* create an opposite ledger effect
* reference the original transaction
* require a reason
* create an audit log

Prevent accidental duplicate reversals unless explicitly supported.

---

# 42. Client Payment Workflow

Client sees:

```text
Current Due:
৳137,750

[ Pay Due ]
```

Payment form:

```text
Current Due:
৳137,750

Payment Amount:
[ ৳________ ]

Payment Method:
[ Select ]

Transaction Reference:
[ Optional ]

Payment Proof:
[ Upload ]

Note:
[ Optional ]

[ Submit Payment ]
```

Client may pay:

* full due
* partial due

Example:

```text
Current Due:
৳137,750

Submitted Payment:
৳50,000
```

While payment is pending:

```text
Current Due remains:
৳137,750
```

Only after Admin approval:

```text
Remaining Due:
৳87,750
```

---

# 43. Payment Model

Suggested fields:

```text
payments

id
payment_number

client_id
payment_request_id nullable

amount_bdt

payment_method
transaction_reference

status

submitted_by
submitted_at

reviewed_by
reviewed_at

admin_note
rejection_reason

created_at
updated_at
```

Suggested statuses:

```text
PENDING
APPROVED
REJECTED
CANCELLED
```

Only:

```text
APPROVED
```

creates a ledger credit.

---

# 44. Payment Proof

Payment submission requires proof unless a future authorized admin-only payment entry workflow explicitly allows otherwise.

Store payment proof using Supabase Storage.

Admin must be able to inspect proof before approval.

Client can view their own submitted proof.

---

# 45. Atomic Payment Approval

Payment approval must be atomic.

Recommended flow:

TanStack Start server function:

```text
Authenticate
↓
Authorize
↓
Validate
↓
Call approve_payment RPC
```

Database transaction:

```text
Lock Payment

Verify:
status = PENDING

Mark APPROVED

Create Ledger Credit

Update linked Payment Request status if applicable

Create financial reference

COMMIT
```

If any step fails:

```text
ROLLBACK
```

Prevent duplicate approval.

---

# 46. Admin Payment Request

Admin must be able to request due payment from a client.

From Client Detail:

```text
Current Due:
৳137,750

[ Request Payment ]
```

Options:

```text
Full Due

or

Custom Amount
```

Example:

```text
Requested Amount:
৳50,000

Due Date:
Optional

Message:
Optional

[ Send Request ]
```

---

# 47. Payment Request Model

Suggested fields:

```text
payment_requests

id
request_number

client_id

requested_amount_bdt

status

message
due_date

created_by
created_at

updated_at
```

Suggested statuses:

```text
REQUESTED
PAYMENT_SUBMITTED
PARTIALLY_PAID
PAID
CANCELLED
```

Do not tightly design V1 around exactly one payment per payment request.

Allow future support for:

```text
One Payment Request
  ↓
Multiple Payments
```

---

# 48. Payment Request Behavior

Example:

```text
Admin requests:
৳50,000
```

Client sees:

```text
Payment Requested:
৳50,000

Current Due:
৳137,750

[ Pay Now ]
```

Client may submit a payment linked to that request.

A payment request itself does not change due.

Only an approved payment changes the ledger.

---

# 49. Overpayment Rules

V1 should prevent normal client payment submission above current outstanding due unless explicitly approved as a supported credit-balance feature.

Server-side validation must compare the payment amount against the authoritative current due.

If future client credit balances are required, implement them intentionally rather than allowing accidental negative due.

---

# 50. Attachments and Storage

Use Supabase Storage.

Recommended private buckets or private path structure for:

```text
limit-proofs
payment-proofs
adjustment-proofs
```

Alternatively, one private bucket with organized paths may be used.

Example:

```text
proofs/
  limit-requests/{requestId}/{uuid}.webp

proofs/
  payments/{paymentId}/{uuid}.webp

proofs/
  adjustments/{adjustmentId}/{uuid}.pdf
```

Do not trust original filenames as storage keys.

Use UUID/randomized storage paths.

---

# 51. Attachment Model

Suggested generic model:

```text
attachments

id

entity_type
entity_id

storage_bucket
storage_path

original_file_name
mime_type
file_size

uploaded_by
created_at
```

Suggested entity types:

```text
LIMIT_APPROVAL_PROOF
PAYMENT_PROOF
ADJUSTMENT_PROOF
OTHER
```

---

# 52. File Access Security

Financial proof files must not be publicly exposed by default.

Recommended flow:

```text
User requests proof
↓
TanStack Start server-side authorization
↓
Verify resource ownership/permission
↓
Generate short-lived signed Supabase Storage URL
↓
Return signed URL
```

Client must only access files related to their own organization.

---

# 53. File Validation

Validate:

* allowed MIME type
* extension where useful
* maximum file size
* required proof presence

Recommended allowed image types:

```text
image/jpeg
image/png
image/webp
```

Optional:

```text
application/pdf
```

Do not rely only on frontend file validation.

---

# 54. Notifications

V1 should support in-app notifications.

Suggested notification events:

```text
LIMIT_REQUEST_CREATED
LIMIT_REQUEST_APPROVED
LIMIT_REQUEST_REJECTED

PAYMENT_REQUEST_CREATED

PAYMENT_SUBMITTED
PAYMENT_APPROVED
PAYMENT_REJECTED

ACCOUNT_ASSIGNED
ACCOUNT_RELEASED
ACCOUNT_TRANSFERRED
```

Suggested model:

```text
notifications

id
user_id

type
title
message

entity_type
entity_id

read_at
created_at
```

Future channels may include:

* Email
* WhatsApp
* SMS

Do not make V1 dependent on external notification providers.

---

# 55. Audit Logs

Audit logging is required for sensitive operations.

Suggested model:

```text
audit_logs

id

actor_user_id

action

entity_type
entity_id

old_values jsonb
new_values jsonb

metadata jsonb

created_at
```

Where practical, metadata may include:

* IP address
* user agent
* request context

Do not store secrets or authentication tokens in audit logs.

---

# 56. Audit Events

Audit at minimum:

* Client created
* Client edited
* Client status changed
* Ad account created
* Ad account renamed
* Ad account status changed
* Account assigned
* Account released
* Account transferred
* Limit request rebased
* Limit request approved
* Limit request rejected
* Approved amount changed from requested amount
* Approval USD rate changed from default
* Default USD rate changed
* Payment submitted
* Payment approved
* Payment rejected
* Payment request created
* Adjustment created
* Reversal created
* Role changed
* Permission changed

---

# 57. Authentication

Use Supabase Auth.

Support at minimum:

* Login
* Logout
* Session validation
* Password reset

Admin/client user provisioning strategy may be implemented according to project requirements.

Do not expose service-role credentials to the browser.

---

# 58. Supabase Client Separation

Use separate Supabase client utilities.

Conceptual structure:

```text
src/lib/supabase/

client.ts
server.ts
admin.server.ts
```

Responsibilities:

```text
client.ts
Safe browser auth/session operations where required.

server.ts
Server-side user-scoped Supabase access.

admin.server.ts
Privileged server-only operations when required.
```

Service-role key:

```text
SERVER ONLY
```

Never bundle it into client code.

Never expose it through public environment variables.

---

# 59. RLS

Use Supabase Row Level Security as a second security boundary.

Do not disable RLS globally just because TanStack Start handles authorization.

RLS strategy:

Clients:

```text
Can access only rows belonging to their client membership.
```

Admins:

Access should be based on server-side authorization and appropriate database access strategy.

Sensitive writes should primarily occur server-side.

RLS policies must be designed carefully so clients cannot bypass TanStack Start and mutate protected business data directly.

---

# 60. Client Direct Database Mutations

Clients must not directly perform sensitive database mutations through browser Supabase calls.

Examples that must go through TanStack Start:

```text
Create Limit Request
Submit Payment
Modify Client Profile fields affecting business data
Access Protected Proofs
```

Admin operations must also go through server-side application logic.

---

# 61. Route Structure

Suggested TanStack Router structure:

```text
src/routes/

__root.tsx

_auth/
  login.tsx
  forgot-password.tsx

_admin/
  route.tsx
  dashboard.tsx

  clients/
    index.tsx
    $clientId.tsx

  ad-accounts/
    index.tsx
    $accountId.tsx

  limit-requests/
    index.tsx
    $requestId.tsx

  payments/
    index.tsx
    $paymentId.tsx

  payment-requests/
    index.tsx

  ledger/
    index.tsx

  adjustments/
    index.tsx

  reports/
    index.tsx

  users/
    index.tsx

  settings/
    index.tsx
    exchange-rate.tsx
    permissions.tsx

_client/
  route.tsx
  dashboard.tsx

  ad-accounts/
    index.tsx

  limit-requests/
    index.tsx
    new.tsx
    $requestId.tsx

  due/
    index.tsx

  payments/
    index.tsx
    new.tsx

  payment-requests/
    index.tsx

  statement/
    index.tsx

  notifications/
    index.tsx

  profile/
    index.tsx
```

Exact file-route syntax should match the installed TanStack Router/Start version.

Do not blindly copy outdated routing conventions.

---

# 62. Route Protection

Admin layout must require:

```text
Authenticated user
+
Admin/Super Admin role
```

Client layout must require:

```text
Authenticated user
+
Valid active ClientMembership
```

Server functions must repeat authorization checks.

Route protection alone is insufficient.

---

# 63. Server-Side Module Structure

Suggested:

```text
src/server/

auth/
  auth.server.ts

clients/
  client.service.ts
  client.queries.ts
  client.schemas.ts

ad-accounts/
  ad-account.service.ts
  assignment.service.ts

limit-requests/
  limit-request.service.ts
  limit-request.schemas.ts

payments/
  payment.service.ts
  payment-request.service.ts

ledger/
  ledger.service.ts

adjustments/
  adjustment.service.ts

exchange-rates/
  exchange-rate.service.ts

storage/
  storage.service.ts

notifications/
  notification.service.ts

audit/
  audit.service.ts
```

Critical business logic must live in reusable server-side services/functions rather than React components.

---

# 64. UI Component Structure

Suggested:

```text
src/components/

ui/
  shadcn components

layout/
  admin-sidebar.tsx
  client-sidebar.tsx
  header.tsx

shared/
  data-table.tsx
  status-badge.tsx
  money-display.tsx
  usd-display.tsx
  proof-viewer.tsx
  confirmation-dialog.tsx

admin/
  client/
  ad-account/
  limit-request/
  payment/
  ledger/

client/
  dashboard/
  ad-account/
  limit-request/
  payment/
```

Avoid oversized page components containing business logic, database calls, and presentation together.

---

# 65. Admin Dashboard

Dashboard summary cards:

```text
Total Clients

Active Ad Accounts

Available Ad Accounts

Pending Limit Requests

Pending Payment Verifications

Total Outstanding Due BDT

Today's Approved Limit USD

Today's Approved Billing BDT

Today's Collection BDT
```

Dashboard sections:

```text
Pending Limit Requests

Pending Payment Verification

Clients With Highest Due

Recent Limit Approvals

Recent Payments

Recent Account Transfers

Recent Activity
```

Dashboard numbers must be calculated from authoritative data.

---

# 66. Client Dashboard

Summary cards:

```text
Active Ad Accounts

Total Approved Limit USD

Total Billed BDT

Total Paid BDT

Current Due BDT

Pending Limit Requests
```

Sections:

```text
My Ad Accounts

Pending Limit Requests

Payment Requests

Recent Payments

Recent Transactions

Notifications
```

---

# 67. Client Ad Accounts Page

Suggested table:

```text
Account
Current Limit
Status
Pending Request
Action
```

Example:

```text
ADA 01

Current Limit:
$600

Status:
ACTIVE

Pending:
None

[ Request Limit ]
```

For inactive accounts:

```text
Request Limit button disabled
```

---

# 68. Limit Request History

Client-visible columns:

```text
Request Number
Ad Account
Opening Balance
Requested Amount
Approved Amount
Applied Rate
New Current Limit
BDT Charge
Status
Proof
Date
```

Example:

```text
LR-000124

ADA 01

Opening:
$600

Requested:
$300

Approved:
$250

Rate:
৳147

New Limit:
$850

Charge:
৳36,750

APPROVED
```

---

# 69. Admin Client Detail Page

Suggested tabs:

```text
Overview
Ad Accounts
Limit Requests
Ledger
Payments
Payment Requests
Adjustments
Activity
```

Overview:

```text
Client Information

Active Accounts

Total Approved USD

Total Billed BDT

Total Paid BDT

Current Due BDT

Pending Limit Requests

Pending Payments
```

Quick actions:

```text
Assign Ad Account
Request Payment
Create Adjustment
View Statement
```

---

# 70. Admin Ad Account Detail

Suggested tabs:

```text
Overview
Assignment History
Limit History
Activity
```

Overview:

```text
Account Name
Account Code
External ID
Platform
Current Client
Current Limit
Status
```

Actions:

```text
Rename
Edit
Activate
Deactivate
Assign
Release
Transfer Client
```

---

# 71. Reports

Initial reports:

```text
Client Due Report

Client Statement

Limit Approval Report

Payment Collection Report

Ad Account Usage Report

Ad Account Assignment History

USD Rate Usage Report

Adjustment/Reversal Report
```

Filters:

```text
Date Range
Client
Ad Account
Status
Admin
USD Rate
```

Future exports:

```text
CSV
Excel
PDF
```

Export implementation is not required before core financial workflows are stable.

---

# 72. Search

Admin global search should eventually support:

```text
Client Name
Client Code

Ad Account Name
Account Code
External Account ID

Limit Request Number

Payment Number

Payment Request Number
```

Use server-side search for scalable datasets.

---

# 73. Status Badges

Use consistent visual status badges.

Examples:

```text
ACTIVE
INACTIVE
AVAILABLE

PENDING
APPROVED
REJECTED
CANCELLED

REQUESTED
PARTIALLY_PAID
PAID
```

Do not rely only on color.

Always include readable text.

---

# 74. Confirmation Dialogs

Require confirmation for sensitive actions:

```text
Approve Limit

Reject Limit

Approve Payment

Reject Payment

Transfer Account

Release Account

Deactivate Account

Create Adjustment

Create Reversal

Change Default USD Rate
```

Confirmation does not replace server-side validation.

---

# 75. Important Business Rules

## Rule 1

A client may have multiple ad accounts.

## Rule 2

An ad account may have only one active client assignment at a time.

## Rule 3

An ad account may move between clients.

Assignment history must never be deleted.

## Rule 4

New assignment opening balance equals the ad account's current limit at assignment time.

## Rule 5

Opening balance from previous usage never creates due for the new client.

## Rule 6

For a limit request:

```text
Opening Balance
=
Current Limit at request baseline
```

## Rule 7

For an approved limit:

```text
New Current Limit
=
Opening Balance
+
Approved Amount
```

## Rule 8

Requested Amount and Approved Amount may differ.

## Rule 9

Admin may edit the USD rate during approval.

## Rule 10

BDT charge is:

```text
Approved USD Amount
×
Approved USD Rate
```

## Rule 11

Only approved limit requests create billing/due.

## Rule 12

Pending limit requests do not affect current limit or due.

## Rule 13

Only approved payments reduce due.

## Rule 14

Pending payments do not reduce due.

## Rule 15

Client due is maintained at client level.

## Rule 16

Ledger is the financial source of truth.

## Rule 17

Approved financial transactions cannot be directly deleted or modified.

## Rule 18

Corrections require adjustment or reversal.

## Rule 19

Inactive ad accounts cannot receive new client limit requests.

## Rule 20

Limit approval requires proof.

## Rule 21

Client payment submission requires proof.

## Rule 22

Critical financial operations must be atomic.

## Rule 23

Historical USD rates must remain unchanged after approval.

## Rule 24

Changing the default USD rate only affects future approval defaults.

## Rule 25

Account renaming must not break historical references.

## Rule 26

Account transfer must preserve previous assignment history.

## Rule 27

Pending operations must never alter authoritative financial balances.

## Rule 28

Financial calculations must be performed server-side using decimal-safe arithmetic.

---

# 76. Example Full Lifecycle Acceptance Scenario

This scenario must be supported and should become an automated integration/E2E test.

## Step 1: Create Client

```text
Client 01
```

## Step 2: Assign Existing Account

Ad Account:

```text
ADA 01
```

Existing current limit:

```text
$50
```

Assignment:

```text
Client:
Client 01

Opening Limit:
$50
```

Client due:

```text
৳0
```

The $50 opening balance creates no billing.

---

## Step 3: Client Requests Limit

Client requests:

```text
$200
```

Request:

```text
Opening:
$50

Requested:
$200

Expected:
$250

Status:
PENDING
```

Client due remains:

```text
৳0
```

---

## Step 4: Admin Approves Different Amount

Admin reviews.

Changes:

```text
Approved Amount:
$180

USD Rate:
৳147
```

Admin uploads proof.

Final:

```text
Opening:
$50

Approved:
$180

New Current Limit:
$230

BDT Charge:
180 × 147
= ৳26,460
```

After approval:

```text
Ad Account Current Limit:
$230

Client Due:
৳26,460
```

Ledger:

```text
LIMIT_APPROVAL
Debit:
৳26,460
```

---

## Step 5: Second Limit Request

Client requests:

```text
$100
```

New request opening:

```text
$230
```

Admin approves:

```text
$100 @ ৳145
```

New current limit:

```text
$330
```

New billing:

```text
৳14,500
```

Total client due:

```text
৳40,960
```

---

## Step 6: Admin Requests Payment

Admin requests:

```text
৳20,000
```

Client sees payment request.

Client submits:

```text
৳20,000
```

with proof.

While pending:

```text
Client Due:
৳40,960
```

Admin approves payment.

Ledger:

```text
PAYMENT
Credit:
৳20,000
```

New due:

```text
৳20,960
```

---

## Step 7: Account Transfer

Client 01 stops using ADA 01.

Current limit:

```text
$330
```

Admin releases/transfers the account.

Client 01 assignment:

```text
Opening:
$50

Closing:
$330

Status:
RELEASED
```

Assign to Client 02:

```text
Opening:
$330

Status:
ACTIVE
```

Client 02 due:

```text
৳0
```

Client 02 only becomes billed when a new limit request is approved.

---

# 77. Additional Acceptance Scenario: Original Multi-Account Example

Client 01 receives four accounts.

## ADA 01

```text
Opening:
$0

Approved Limit:
$400

Current Limit:
$400
```

Client billable USD:

```text
$400
```

## ADA 02

```text
Opening:
$50

Approved Limit:
$200

Current Limit:
$250
```

Client billable USD:

```text
$200
```

## ADA 03

```text
Opening:
$0

Approved Limit:
$50

Current Limit:
$50
```

Client billable USD:

```text
$50
```

## ADA 04

```text
Opening:
$800

Approved Limit:
$300

Current Limit:
$1100
```

Client billable USD:

```text
$300
```

Total newly approved USD:

```text
$950
```

The opening balances:

```text
$0
$50
$0
$800
```

must never be included in the client's newly purchased USD or billing.

BDT billing depends on the approved USD rate snapshot for each approval.

---

# 78. Database Constraints

Use database constraints where practical.

Examples:

* foreign keys
* NOT NULL for required fields
* CHECK amount > 0 where appropriate
* unique request/payment numbers
* unique stable account codes
* only one active assignment per ad account
* only one pending limit request per active assignment/account where supported by the chosen model
* valid enum/status values
* no negative approved amount
* no zero-value financial transaction unless explicitly supported

Application validation alone is insufficient for critical invariants.

---

# 79. Database Indexes

Create indexes for common queries.

At minimum consider:

```text
clients.client_code

ad_accounts.account_code
ad_accounts.external_account_id
ad_accounts.status

ad_account_assignments.ad_account_id
ad_account_assignments.client_id
ad_account_assignments.status

limit_requests.client_id
limit_requests.ad_account_id
limit_requests.assignment_id
limit_requests.status
limit_requests.created_at

payments.client_id
payments.status
payments.created_at

payment_requests.client_id
payment_requests.status

ledger_entries.client_id
ledger_entries.created_at
ledger_entries.type

notifications.user_id
notifications.read_at

audit_logs.entity_type
audit_logs.entity_id
audit_logs.created_at
```

Use partial unique indexes where appropriate.

---

# 80. Concurrency

The system must protect against:

* double limit approval
* double payment approval
* concurrent account transfers
* stale opening balances
* duplicate pending requests
* duplicate reversals

Use:

* PostgreSQL transactions
* row locking where appropriate
* constraints
* status validation
* idempotency where useful

Do not depend on frontend button disabling as concurrency protection.

---

# 81. Serverless Compatibility

Because deployment uses Vercel serverless functions:

Do not depend on:

```text
Persistent local disk

Long-running memory state

Global mutable business state

In-process job queues requiring one persistent server

Sticky sessions
```

Use:

```text
Supabase Postgres
Supabase Storage
Database-backed state
```

for persistence.

---

# 82. Nitro / Vercel Configuration

Use the Nitro configuration required by the installed TanStack Start version for Vercel serverless deployment.

Before implementation:

1. Verify the current official TanStack Start deployment guidance.
2. Verify the compatible Nitro/Vercel preset.
3. Configure environment variables correctly.
4. Avoid copying outdated framework configuration from old tutorials.

Expected environment categories:

```text
SUPABASE_URL

SUPABASE_ANON_KEY or publishable key as required by current Supabase SDK

SUPABASE_SERVICE_ROLE_KEY
SERVER ONLY

Other server secrets
SERVER ONLY
```

Never expose service-role credentials through `VITE_*` or public client environment variables.

---

# 83. Suggested Project Structure

```text
rush-tracker/
│
├── CLAUDE.md
├── docs/
│   └── PROJECT_SPEC.md
│
├── src/
│   ├── routes/
│   │
│   ├── components/
│   │   ├── ui/
│   │   ├── layout/
│   │   ├── shared/
│   │   ├── admin/
│   │   └── client/
│   │
│   ├── server/
│   │   ├── auth/
│   │   ├── clients/
│   │   ├── ad-accounts/
│   │   ├── limit-requests/
│   │   ├── payments/
│   │   ├── ledger/
│   │   ├── adjustments/
│   │   ├── exchange-rates/
│   │   ├── storage/
│   │   ├── notifications/
│   │   └── audit/
│   │
│   ├── lib/
│   │   ├── supabase/
│   │   ├── auth/
│   │   ├── permissions/
│   │   ├── money/
│   │   └── utils/
│   │
│   ├── schemas/
│   └── types/
│
├── supabase/
│   ├── migrations/
│   ├── seed.sql
│   └── config.toml
│
├── public/
│
├── app.config.ts
├── vite.config.ts
├── components.json
├── package.json
└── tsconfig.json
```

Adapt exact files to the installed framework version.

---

# 84. Development Phases

Do not attempt to implement the entire application in one uncontrolled pass.

## Phase 0: Architecture Verification

Before writing major implementation code:

* Read this specification fully.
* Inspect installed package versions.
* Verify current TanStack Start conventions.
* Verify TanStack Router file routing conventions.
* Verify Supabase SSR/Auth integration.
* Verify current Nitro/Vercel deployment setup.
* Produce implementation plan.
* Identify conflicts or missing requirements.

Do not silently substitute frameworks.

---

## Phase 1: Foundation

Implement:

```text
TanStack Start project foundation

TanStack Router

TypeScript strict configuration

Tailwind CSS

shadcn/ui

Supabase clients

Supabase Auth

Session handling

Admin layout

Client layout

Role model

ClientMembership model

Basic RBAC

Route protection

Environment validation
```

Acceptance:

* Login works.
* Session works server-side.
* Admin routes reject unauthorized users.
* Client routes reject unauthorized users.
* Client membership scoping works.
* Service-role secret never reaches browser bundle.

Stop and review before Phase 2.

---

## Phase 2: Clients and Ad Accounts

Implement:

```text
Client CRUD

Ad Account CRUD

Rename Account

Activate/Deactivate

Assign Account

Release Account

Transfer Account

Assignment History
```

Acceptance:

* One account cannot have two active assignments.
* Transfer preserves history.
* New client opening balance equals current account limit.
* Transfer creates no client due.
* Rename preserves historical references.

Stop and review.

---

## Phase 3: Limit Management

Implement:

```text
Client Limit Request

One Pending Request Rule

Admin Pending Queue

Approval Form

Editable Approved Amount

Editable USD Rate

Default USD Rate

Proof Upload

Stale Balance Detection

Rebase Flow

Atomic Approval RPC

Current Limit Update

Limit History
```

Acceptance:

* Pending request changes no due.
* Admin may approve different amount.
* Admin may change rate.
* Approval proof required.
* New current limit uses approved amount.
* Historical rate snapshot remains immutable.
* Stale request cannot approve silently.
* Duplicate approval impossible.

Stop and review.

---

## Phase 4: Ledger and Accounting

Implement:

```text
Ledger

Client BDT Due

Total Billed

Total Paid

USD Approval Totals

Adjustments

Reversals

Financial Statement
```

Acceptance:

* Ledger is source of truth.
* Opening balance never creates billing.
* Approved limit creates debit.
* Adjustment creates correct ledger effect.
* Reversal preserves original transaction.
* Approved financial records cannot be directly edited/deleted.

Stop and review.

---

## Phase 5: Payments

Implement:

```text
Pay Due

Partial Payment

Payment Proof

Pending Payment Queue

Atomic Payment Approval

Payment Rejection

Admin Payment Requests

Payment Request Status

Payment History
```

Acceptance:

* Pending payment does not reduce due.
* Approved payment creates ledger credit.
* Partial payment works.
* Duplicate approval impossible.
* Payment request itself does not change due.
* Client cannot normally overpay beyond due.

Stop and review.

---

## Phase 6: Dashboards

Implement:

```text
Admin Dashboard

Client Dashboard

Summary Cards

Pending Queues

Recent Activity

Due Summaries
```

Validate all dashboard calculations against authoritative data.

---

## Phase 7: Notifications, Reports and Audit

Implement:

```text
In-App Notifications

Audit Log UI

Reports

Filters

Search

Optional Exports
```

---

## Phase 8: Hardening

Perform:

```text
RLS review

Authorization review

Financial reconciliation tests

Concurrency tests

File access tests

Serverless deployment tests

Vercel deployment

Production environment verification
```

---

# 85. Testing Requirements

Use appropriate automated tests.

Critical business logic must have tests.

At minimum test:

```text
Opening balance behavior

Limit request creation

Approved amount differs from requested

Editable USD rate

BDT billing calculation

Stale opening balance rejection

Duplicate limit approval prevention

Account transfer

Transfer opening balance

No billing from opening balance

Payment submission

Pending payment behavior

Payment approval

Partial payment

Duplicate payment approval prevention

Adjustment

Reversal

Client-level due calculation

Cross-client authorization denial
```

> **[TRUNCATED]** — The original document continued past this point (remainder of Section 85
> and any later sections) but was cut off in transmission. Replace this file with the full
> original specification.
