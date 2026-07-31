/* SPDX-License-Identifier: LGPL-2.1-or-later */
import cockpit from "cockpit";
import { invokeStatusHook, type StatusHookState } from "../services/status-hook";
import type { StatusHookConfig } from "../types";
import { HOOKS_DIR } from "../paths";

describe("invokeStatusHook", () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test("does nothing when config is undefined", async () => {
        await invokeStatusHook(undefined, "ready");
        expect(cockpit.spawn).not.toHaveBeenCalled();
    });

    test("does nothing when not enabled", async () => {
        await invokeStatusHook({ enabled: false, tool: "my-hook" }, "ready");
        expect(cockpit.spawn).not.toHaveBeenCalled();
    });

    test("does nothing when enabled but no tool", async () => {
        await invokeStatusHook({ enabled: true }, "ready");
        expect(cockpit.spawn).not.toHaveBeenCalled();
    });

    test("does nothing when enabled but empty tool", async () => {
        await invokeStatusHook({ enabled: true, tool: "" }, "ready");
        expect(cockpit.spawn).not.toHaveBeenCalled();
    });

    test("calls cockpit.spawn with sudo, correct path, and state", async () => {
        const config: StatusHookConfig = { enabled: true, tool: "my-hook" };
        await invokeStatusHook(config, "ready");

        expect(cockpit.spawn).toHaveBeenCalledWith(
            ["sudo", `${HOOKS_DIR}/my-hook`, "ready"],
            { err: "message" }
        );
    });

    test("does not throw when spawn fails", async () => {
        jest.mocked(cockpit.spawn).mockReturnValueOnce(
            Promise.reject(new Error("spawn failed")) as ReturnType<typeof cockpit.spawn>
        );

        const config: StatusHookConfig = { enabled: true, tool: "my-hook" };
        await expect(invokeStatusHook(config, "error")).resolves.toBeUndefined();
    });

    test("calls with correct state argument for each state", async () => {
        const config: StatusHookConfig = { enabled: true, tool: "test-hook" };
        const states: StatusHookState[] = ["ready", "in-progress", "applying", "success", "error", "off"];

        for (const state of states) {
            jest.clearAllMocks();
            await invokeStatusHook(config, state);
            expect(cockpit.spawn).toHaveBeenCalledWith(
                ["sudo", `${HOOKS_DIR}/test-hook`, state],
                { err: "message" }
            );
        }
    });
});
