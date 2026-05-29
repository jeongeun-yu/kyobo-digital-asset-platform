package io.coincraft.kyobo.gateway.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;

public record RewardNotificationRequest(
    @NotBlank String userId,
    @NotBlank String rewardType,
    @NotBlank String tokenId,
    @NotBlank String txHash
) {}
