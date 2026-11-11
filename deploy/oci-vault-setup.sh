#!/usr/bin/env bash
# One-time Oracle Cloud setup so the MTG Table server keeps its secrets in OCI Vault instead of on disk.
# Run it in Cloud Shell (Oracle console, top right >_ icon), which is already signed in as you:
#
#   curl -fsSL https://raw.githubusercontent.com/Braden-Develops/mtg-table/main/deploy/oci-vault-setup.sh | bash
#
# Creates (or reuses) in the root compartment, all within the Always Free tier:
#   vault "mtg-table" (default type), software-protected AES key "mtg-table",
#   secret "mtg-livekit-secret" (a new random value made here; nobody sees it),
#   secret "mtg-discord-token" (placeholder; the host page fills it in),
#   dynamic group "mtg-table" (the VM named mtg-table) and policy "mtg-table-secrets"
#   letting only that VM read those secrets and update the Discord token (it may also list secret
#   names, never their contents, to find its vault).
# Also policy "mtg-table-cost": the VM may read (never change) the tenancy's cost and budgets, so
# Grafana can show spend (server/cost.js).
#
# Optional monthly budget with email alerts (sent by Oracle, so they work even if the VM is down):
#
#   curl -fsSL .../oci-vault-setup.sh | BUDGET=10 ALERT_EMAIL=you@example.com bash
#
# creates budget "mtg-table" of 10 (your billing currency) per month for the whole tenancy, emailing
# when actual spend passes 50% and 100%, and when Oracle forecasts the month will pass 100%.
# Safe to run again.
set -euo pipefail

VM_NAME="${VM_NAME:-mtg-table}"
T="${OCI_TENANCY:?Run this in OCI Cloud Shell}"
say() { printf '\n== %s\n' "$*"; }

say "Finding the VM \"$VM_NAME\""
INST=$(oci compute instance list -c "$T" --lifecycle-state RUNNING --all \
  --query "data[?\"display-name\"=='$VM_NAME'].id | [0]" --raw-output)
[ -n "$INST" ] && [ "$INST" != "null" ] || { echo "No running VM named $VM_NAME in the root compartment."; exit 1; }
echo "found"

say "Vault"
VAULT=$(oci kms management vault list -c "$T" --all \
  --query "data[?\"display-name\"=='mtg-table' && \"lifecycle-state\"=='ACTIVE'].id | [0]" --raw-output)
if [ -z "$VAULT" ] || [ "$VAULT" = "null" ]; then
  echo "creating (takes a minute or two)"
  VAULT=$(oci kms management vault create -c "$T" --display-name mtg-table --vault-type DEFAULT \
    --wait-for-state ACTIVE --query data.id --raw-output)
else
  echo "already there"
fi
MGMT=$(oci kms management vault get --vault-id "$VAULT" --query 'data."management-endpoint"' --raw-output)

say "Key"
KEY=$(oci kms management key list -c "$T" --endpoint "$MGMT" --all \
  --query "data[?\"display-name\"=='mtg-table' && \"lifecycle-state\"=='ENABLED'].id | [0]" --raw-output)
if [ -z "$KEY" ] || [ "$KEY" = "null" ]; then
  echo "creating"
  KEY=$(oci kms management key create -c "$T" --endpoint "$MGMT" --display-name mtg-table \
    --key-shape '{"algorithm":"AES","length":32}' --protection-mode SOFTWARE \
    --wait-for-state ENABLED --query data.id --raw-output)
else
  echo "already there"
fi

make_secret() { # name, value
  local id
  id=$(oci vault secret list -c "$T" --vault-id "$VAULT" --name "$1" --all \
    --query "data[?\"lifecycle-state\"=='ACTIVE'].id | [0]" --raw-output)
  if [ -n "$id" ] && [ "$id" != "null" ]; then echo "$1: already there"; return; fi
  oci vault secret create-base64 -c "$T" --vault-id "$VAULT" --key-id "$KEY" --secret-name "$1" \
    --secret-content-content "$(printf '%s' "$2" | base64 -w0)" --wait-for-state ACTIVE >/dev/null
  echo "$1: created"
}
say "Secrets"
make_secret mtg-livekit-secret "$(openssl rand -base64 48 | tr -d '\n=/+' | cut -c1-43)"
make_secret mtg-discord-token "unset"

say "Dynamic group"
if oci iam dynamic-group list --all --query "data[?name=='mtg-table'].id | [0]" --raw-output | grep -q ocid1; then
  echo "already there"
else
  oci iam dynamic-group create --name mtg-table --description "MTG Table VM (reads its secrets from the vault)" \
    --matching-rule "ALL {instance.id = '$INST'}" >/dev/null
  echo "created"
fi

say "Policy"
STATEMENTS=$(cat <<EOF
["Allow dynamic-group mtg-table to inspect secrets in tenancy",
 "Allow dynamic-group mtg-table to read secret-bundles in tenancy where target.vault.id = '$VAULT'",
 "Allow dynamic-group mtg-table to use secrets in tenancy where target.vault.id = '$VAULT'",
 "Allow dynamic-group mtg-table to use keys in tenancy where target.key.id = '$KEY'"]
EOF
)
POL=$(oci iam policy list -c "$T" --all --query "data[?name=='mtg-table-secrets'].id | [0]" --raw-output)
if [ -n "$POL" ] && [ "$POL" != "null" ]; then
  oci iam policy update --policy-id "$POL" --statements "$STATEMENTS" --version-date "" --force >/dev/null
  echo "updated"
else
  oci iam policy create -c "$T" --name mtg-table-secrets --description "MTG Table VM: its own secrets only" \
    --statements "$STATEMENTS" >/dev/null
  echo "created"
fi

say "Cost policy"
COST_STATEMENTS='["Allow dynamic-group mtg-table to read usage-report in tenancy",
 "Allow dynamic-group mtg-table to read usage-budgets in tenancy"]'
CPOL=$(oci iam policy list -c "$T" --all --query "data[?name=='mtg-table-cost'].id | [0]" --raw-output)
if [ -n "$CPOL" ] && [ "$CPOL" != "null" ]; then
  oci iam policy update --policy-id "$CPOL" --statements "$COST_STATEMENTS" --version-date "" --force >/dev/null
  echo "updated"
else
  oci iam policy create -c "$T" --name mtg-table-cost --description "MTG Table VM: read cost and budgets for Grafana" \
    --statements "$COST_STATEMENTS" >/dev/null
  echo "created"
fi

say "Budget"
if [ -z "${BUDGET:-}" ] || [ -z "${ALERT_EMAIL:-}" ]; then
  echo "skipped (run again with BUDGET=<monthly amount> ALERT_EMAIL=<address> to add one)"
else
  BUD=$(oci budgets budget list -c "$T" --all --target-type ALL \
    --query "data[?\"display-name\"=='mtg-table'].id | [0]" --raw-output)
  if [ -n "$BUD" ] && [ "$BUD" != "null" ]; then
    oci budgets budget update --budget-id "$BUD" --amount "$BUDGET" --force >/dev/null
    echo "already there; amount set to $BUDGET"
  else
    BUD=$(oci budgets budget create -c "$T" --display-name mtg-table --amount "$BUDGET" --reset-period MONTHLY \
      --target-type COMPARTMENT --targets "[\"$T\"]" --description "MTG Table monthly spend" \
      --query data.id --raw-output)
    echo "created ($BUDGET per month)"
  fi
  alert() { # name, type, percent
    local id
    id=$(oci budgets alert-rule list --budget-id "$BUD" --all --query "data[?\"display-name\"=='$1'].id | [0]" --raw-output)
    if [ -n "$id" ] && [ "$id" != "null" ]; then
      oci budgets alert-rule update --budget-id "$BUD" --alert-rule-id "$id" --recipients "$ALERT_EMAIL" --force >/dev/null
      echo "alert $1: already there (recipient updated)"
    else
      oci budgets alert-rule create --budget-id "$BUD" --display-name "$1" --type "$2" --threshold "$3" \
        --threshold-type PERCENTAGE --recipients "$ALERT_EMAIL" \
        --message "MTG Table: Oracle Cloud spend alert ($1)" >/dev/null
      echo "alert $1: created"
    fi
  }
  alert actual-50 ACTUAL 50
  alert actual-100 ACTUAL 100
  alert forecast-100 FORECAST 100
fi

say "Done. Tell Claude it finished; the server finds the vault by its name."
