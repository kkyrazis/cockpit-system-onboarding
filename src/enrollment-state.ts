import type { ServiceEnrollmentConfig } from "./types";

export const DEFAULT_ENROLLMENT_CONFIG: ServiceEnrollmentConfig = {
    selected: true,
    useExisting: false,
    tlsMode: "system",
};

export function patchEnrollment(
    enrollment: ServiceEnrollmentConfig,
    patch: Partial<ServiceEnrollmentConfig>
): ServiceEnrollmentConfig {
    return { ...enrollment, ...patch };
}

export type PersistedEnrollmentState = Omit<ServiceEnrollmentConfig, "credentials">;

export function serializeEnrollmentForMarker(enrollment: ServiceEnrollmentConfig): PersistedEnrollmentState {
    const marker: PersistedEnrollmentState = {
        selected: enrollment.selected,
    };

    if (enrollment.endpoint !== undefined) {
        marker.endpoint = enrollment.endpoint;
    }
    if (enrollment.useExisting !== undefined) {
        marker.useExisting = enrollment.useExisting;
    }
    if (enrollment.tlsMode !== undefined) {
        marker.tlsMode = enrollment.tlsMode;
    }
    if (enrollment.caCertPem !== undefined) {
        marker.caCertPem = enrollment.caCertPem;
    }

    return marker;
}

export function restoreEnrollmentFromMarker(
    marker: PersistedEnrollmentState | undefined,
    current: ServiceEnrollmentConfig
): ServiceEnrollmentConfig {
    if (!marker) {
        return current;
    }

    return patchEnrollment(current, marker);
}
