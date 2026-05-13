package io.coincraft.kyobo.gateway.dto;

public record UserAccountResponse(
    String userId,
    String walletAddress,       // nullable — 지갑 미연동 시 null
    String kycLevel,            // NONE | BASIC | ENHANCED | INVESTOR
    boolean isActive
) {}
