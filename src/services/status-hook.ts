/* SPDX-License-Identifier: LGPL-2.1-or-later */
import cockpit from "cockpit";
import type { StatusHookConfig } from "../types";
import { HOOKS_DIR } from "../paths";

export type StatusHookState = "ready" | "in-progress" | "applying" | "success" | "error" | "off";

/**
 * Invoke the user-provided status hook with a lifecycle state argument.
 *
 * Failures are logged but never thrown — the hook must not block onboarding.
 */
export async function invokeStatusHook(
    config: StatusHookConfig | undefined,
    state: StatusHookState
): Promise<void> {
    if (!config?.enabled || !config?.tool) {
        return;
    }

    try {
        await cockpit.spawn(["sudo", `${HOOKS_DIR}/${config.tool}`, state], { err: "message" });
    } catch (error) {
        console.warn(`Status hook failed for state '${state}':`, error);
    }
}
