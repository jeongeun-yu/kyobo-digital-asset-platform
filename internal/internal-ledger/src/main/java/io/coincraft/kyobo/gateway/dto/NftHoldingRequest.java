package io.coincraft.kyobo.gateway.dto;

import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import java.time.Instant;

public record NftHoldingRequest(
    @NotNull Long tokenId,
    @NotBlank String contractAddr,
    @NotNull Integer chainId,
    @NotNull @Min(1) Long amount,
    @NotNull Instant acquiredAt,
    @NotBlank String onChainTx
) {}
