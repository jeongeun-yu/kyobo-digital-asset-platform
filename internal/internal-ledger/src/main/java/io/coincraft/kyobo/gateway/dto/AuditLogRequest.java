package io.coincraft.kyobo.gateway.dto;

import jakarta.validation.constraints.NotBlank;

public record AuditLogRequest(
    @NotBlank String actor,
    @NotBlank String action,
    @NotBlank String resourceType,
    @NotBlank String resourceId,
    String beforeState,       // nullable — 신규 생성 시 null
    @NotBlank String afterState
) {}
