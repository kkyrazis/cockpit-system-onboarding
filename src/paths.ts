/* SPDX-License-Identifier: LGPL-2.1-or-later */
export const MARKER_DIR = "/var/lib/flightctl-onboarding";
export const MARKER_COMPLETE = `${MARKER_DIR}/.onboarding-complete`;
export const MARKER_ATTEMPTED = `${MARKER_DIR}/.onboarding-attempted`;
export const WATCHDOG_ACTIVE = `${MARKER_DIR}/.watchdog-active`;
export const WATCHDOG_STATUS = `${MARKER_DIR}/.watchdog-status`;

export const SCRIPTS_DIR = "/usr/libexec/flightctl-onboarding";
export const SCRIPT_CLEANUP = `${SCRIPTS_DIR}/cleanup-onboarding.sh`;
export const SCRIPT_FINALIZE = `${SCRIPTS_DIR}/finalize-onboarding.sh`;
export const SCRIPT_NTP = `${SCRIPTS_DIR}/configure-ntp.sh`;
export const SCRIPT_PROXY = `${SCRIPTS_DIR}/apply-proxy.sh`;
export const SCRIPT_LABELS = `${SCRIPTS_DIR}/apply-labels.sh`;
export const SCRIPT_APPLY_ENROLL = `${SCRIPTS_DIR}/apply-and-enroll.sh`;
export const SCRIPT_RUN_APPLY_ENROLL = `${SCRIPTS_DIR}/run-apply-enroll.sh`;
export const SCRIPT_CHECK_NETWORK = `${SCRIPTS_DIR}/check-network.sh`;
export const SCRIPT_CHECK_CONNECTIVITY = `${SCRIPTS_DIR}/check-connectivity.sh`;
export const SCRIPT_RUN_WATCHDOG = `${SCRIPTS_DIR}/run-watchdog.sh`;
export const SCRIPT_ROLLBACK = `${SCRIPTS_DIR}/rollback-config.sh`;
export const SCRIPT_READ_FLIGHTCTL_CONFIG = `${SCRIPTS_DIR}/read-flightctl-config.sh`;

export const HOOKS_DIR = `${SCRIPTS_DIR}/hooks.d`;

export const ONBOARDING_PROFILE_PREFIX = "flightctl-onboarding-";
