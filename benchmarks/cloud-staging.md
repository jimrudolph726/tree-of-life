# Cloud staging deployment — September 25, 2026

Public HTTPS site: https://dgilsep5ai167.cloudfront.net/

AWS stack: `tree-of-life-staging` in `us-east-1`. Private S3 stores shared,
versioned tree data and retained app releases; CloudFront provides the public
URL. Full tree, Birds and Primates are available.

## Validation

- CloudFormation schema validation passed with cfn-lint.
- Production build, ESLint, 23 Node tests and 16 Python tests passed.
- Release preflight selected 48,839 files, 2,314,211,972 uncompressed bytes for
  the initial release. All objects are compressed before upload; immutable
  objects are reused on subsequent deployment.
- Live HTTP/shared-store smoke checks passed for all three datasets, including
  human navigation at source depths 59 (full tree) and 25 (Primates), and bird
  navigation at depth 60. Desktop/narrow scene coordinates remained finite.
- CloudFront returned gzip responses, immutable cache headers and a confirmed
  cache hit on a repeat asset request. Anonymous access to the same S3 object
  returned HTTP 403.
- Browser checks on the actual hosted URL confirmed the opening map, human
  search/deep navigation, Back/Forward and both smaller dataset selections.
  The 390 × 844 opening layout was inspected; no console warnings/errors were
  observed during the hosted navigation checks.
- The user independently confirmed the public URL and tree work correctly.

Reports: [initial live smoke](results/cloud-staging-smoke.json) and
[rollback smoke](results/cloud-rollback-smoke.json).

## Releases and operations

Initial release: `56ad72ab77d9668d54849aac`.
Latest release: `cd809872ef8fefaf5b05fe85` (adds the official release-download
link to the attribution file; the app and scientific data are unchanged).
The initial release was successfully reactivated to exercise real rollback;
the final handoff restores the latest release.

The account-wide monthly budget is USD 25, with actual-cost notification at
80% and forecast notification at 100%. This is an alert, not a spending cap.
An AWS CloudWatch alarm tracks the distribution's 5xx rate; no email action
is attached to that alarm.

GitHub's `staging` environment and deployment variables are configured, with
main-branch-only deployments and an OIDC role scoped to this bucket and
distribution. At the initial cloud handoff the workflow was local; the follow-up
source-control publication includes it and its required app/data pipeline.
A GitHub Actions deployment has not yet been exercised.
The local deployment and rollback commands have been exercised against AWS.

Physical-phone and real mobile-network tests remain future checks. Narrow
viewport testing used desktop hardware. An optional throttled CloudFront proxy
is supplied for further testing; no new hosted slow-network benchmark is
claimed in this report.

See [the operations guide](../infra/README.md) for deployment, rollback,
credentials, caching, retained-storage costs and infrastructure updates.
