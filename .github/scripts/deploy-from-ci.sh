#!/usr/bin/env bash
set -Eeuo pipefail
: "${DEPLOY_HOST:?Set production DEPLOY_HOST}"
: "${DEPLOY_USER:?Set production DEPLOY_USER}"
: "${DEPLOY_SSH_KEY:?Set production DEPLOY_SSH_KEY}"
: "${DEPLOY_KNOWN_HOSTS:?Set verified production DEPLOY_KNOWN_HOSTS}"
: "${DEPLOY_COMPONENT:?Set backend or frontend}"
[[ "$DEPLOY_COMPONENT" == backend || "$DEPLOY_COMPONENT" == frontend ]]
: "${GITHUB_SHA:?Missing revision}"
[[ "$GITHUB_SHA" =~ ^[a-f0-9]{40}$ ]]
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
printf '%s\n' "$DEPLOY_SSH_KEY" > "$work/key"
printf '%s\n' "$DEPLOY_KNOWN_HOSTS" > "$work/known_hosts"
chmod 600 "$work/key" "$work/known_hosts"
options=(-i "$work/key" -o BatchMode=yes -o StrictHostKeyChecking=yes -o "UserKnownHostsFile=$work/known_hosts")
# git archive includes only the reviewed revision, never local env or uploaded media.
git archive --format=tar.gz --output="$work/source.tar.gz" "$GITHUB_SHA"
ssh "${options[@]}" "$DEPLOY_USER@$DEPLOY_HOST" "mkdir -p /opt/intexa-releases/$DEPLOY_COMPONENT-$GITHUB_SHA"
scp "${options[@]}" "$work/source.tar.gz" "$DEPLOY_USER@$DEPLOY_HOST:/opt/intexa-releases/$DEPLOY_COMPONENT-$GITHUB_SHA/source.tar.gz"
ssh "${options[@]}" "$DEPLOY_USER@$DEPLOY_HOST" "tar -xzf /opt/intexa-releases/$DEPLOY_COMPONENT-$GITHUB_SHA/source.tar.gz -C /opt/intexa-releases/$DEPLOY_COMPONENT-$GITHUB_SHA && bash /opt/intexa-releases/$DEPLOY_COMPONENT-$GITHUB_SHA/.github/scripts/deploy-production.sh $DEPLOY_COMPONENT $GITHUB_SHA"
