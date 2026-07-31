#!/bin/bash
# Invoke the status hook with 'ready' state during first-boot setup
# Part of flightctl-onboarding first-boot setup

set -e

# shellcheck source=common.sh
. /usr/libexec/flightctl-onboarding/common.sh

invoke_status_hook "ready"

exit 0
