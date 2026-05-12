package io.coincraft.kyobo.gateway.entity;

import jakarta.persistence.*;
import lombok.*;
import java.time.Instant;

/**
 * 사용자 NFT 보유 현황 — 영구 금융 원장
 *
 * 설계 원칙:
 *   - 온체인이 단일 진실. 이 테이블은 온체인 Transfer 이벤트에서 파생된다.
 *   - released_at = NULL: 현재 보유 중
 *   - released_at != NULL: 소각/이전됨
 *   - 역방향 동기화(오프체인 → 온체인) 절대 금지
 *
 * 보존 기간: 가상자산이용자보호법 §15 → 5년
 */
@Entity
@Table(name = "user_nft_holdings",
    uniqueConstraints = @UniqueConstraint(columnNames = {"token_id", "contract_addr", "chain_id"}))
@Getter
@NoArgsConstructor(access = AccessLevel.PROTECTED)
public class NftHolding {

    @Id
    @GeneratedValue(strategy = GenerationType.SEQUENCE, generator = "nft_holding_seq")
    @SequenceGenerator(name = "nft_holding_seq", sequenceName = "nft_holding_seq", allocationSize = 1)
    private Long id;

    @Column(name = "user_id", nullable = false, length = 64)
    private String userId;

    @Column(name = "token_id", nullable = false)
    private Long tokenId;

    @Column(name = "contract_addr", nullable = false, length = 42)
    private String contractAddr;

    @Column(name = "chain_id", nullable = false)
    private Integer chainId;

    @Column(name = "acquired_at", nullable = false)
    private Instant acquiredAt;

    @Column(name = "released_at")
    private Instant releasedAt;

    @Column(name = "on_chain_tx", nullable = false, length = 66)
    private String onChainTx;

    public static NftHolding of(String userId, Long tokenId, String contractAddr,
                                 Integer chainId, Instant acquiredAt, String onChainTx) {
        NftHolding h = new NftHolding();
        h.userId = userId;
        h.tokenId = tokenId;
        h.contractAddr = contractAddr;
        h.chainId = chainId;
        h.acquiredAt = acquiredAt;
        h.onChainTx = onChainTx;
        return h;
    }

    public void release() {
        this.releasedAt = Instant.now();
    }
}
