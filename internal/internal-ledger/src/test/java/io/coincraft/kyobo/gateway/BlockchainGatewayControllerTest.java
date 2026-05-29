package io.coincraft.kyobo.gateway;

import io.coincraft.kyobo.gateway.repository.AuditLogRepository;
import io.coincraft.kyobo.gateway.repository.NftHoldingRepository;
import io.coincraft.kyobo.gateway.service.AuditLogService;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

@SpringBootTest
@AutoConfigureMockMvc
class BlockchainGatewayControllerTest {

    @Autowired private MockMvc mockMvc;
    @Autowired private NftHoldingRepository nftHoldingRepository;
    @Autowired private AuditLogRepository auditLogRepository;
    @Autowired private AuditLogService auditLogService;

    @Test
    void healthCheck_returns200() throws Exception {
        mockMvc.perform(get("/api/internal/health"))
               .andExpect(status().isOk());
    }

    @Test
    void recordNftHolding_savesToDb() throws Exception {
        String userId = "user-test-holding-001";
        String body = """
                {
                  "tokenId": 1001,
                  "contractAddr": "0x4b0897b0513fdc7c541b6d9d7e929c4e5364d2db",
                  "chainId": 1,
                  "amount": 3,
                  "acquiredAt": "2026-05-19T04:00:00Z",
                  "onChainTx": "0xaaaa0000bbbb1111cccc2222dddd3333aaaa0000bbbb1111cccc2222dddd3333"
                }
                """;

        mockMvc.perform(post("/api/internal/users/{userId}/nft-holdings", userId)
                .contentType(MediaType.APPLICATION_JSON)
                .content(body))
               .andExpect(status().isOk());

        var saved = nftHoldingRepository
            .findByUserIdAndTokenIdAndContractAddrAndChainIdAndReleasedAtIsNull(
                userId, 1001L, "0x4b0897b0513fdc7c541b6d9d7e929c4e5364d2db", 1);

        assertThat(saved).isPresent();
        assertThat(saved.get().getAmount()).isEqualTo(3L);
        assertThat(saved.get().getUserId()).isEqualTo(userId);
        assertThat(saved.get().getOnChainTx())
            .isEqualTo("0xaaaa0000bbbb1111cccc2222dddd3333aaaa0000bbbb1111cccc2222dddd3333");
        assertThat(saved.get().getReleasedAt()).isNull();
    }

    @Test
    void recordNftHolding_duplicateIsIdempotent() throws Exception {
        String userId = "user-test-holding-002";
        String body = """
                {
                  "tokenId": 2002,
                  "contractAddr": "0x4b0897b0513fdc7c541b6d9d7e929c4e5364d2db",
                  "chainId": 1,
                  "amount": 1,
                  "acquiredAt": "2026-05-19T04:00:00Z",
                  "onChainTx": "0xbbbb0000cccc1111dddd2222eeee3333bbbb0000cccc1111dddd2222eeee3333"
                }
                """;

        // 동일 요청 2회 — 두 번째는 skip (DB 레코드는 1건만)
        mockMvc.perform(post("/api/internal/users/{userId}/nft-holdings", userId)
                .contentType(MediaType.APPLICATION_JSON).content(body))
               .andExpect(status().isOk());
        mockMvc.perform(post("/api/internal/users/{userId}/nft-holdings", userId)
                .contentType(MediaType.APPLICATION_JSON).content(body))
               .andExpect(status().isOk());

        long count = nftHoldingRepository.findAll().stream()
            .filter(h -> h.getUserId().equals(userId) && h.getTokenId().equals(2002L))
            .count();
        assertThat(count).isEqualTo(1);
    }

    @Test
    void recordAuditLog_appendsOnly() throws Exception {
        long countBefore = auditLogRepository.count();

        String body = """
                {
                  "actor": "system",
                  "action": "CREDITED",
                  "resourceType": "NftHolding",
                  "resourceId": "0x4b0897b0513fdc7c541b6d9d7e929c4e5364d2db:1001",
                  "beforeState": null,
                  "afterState": "{\\"tokenId\\":1001,\\"amount\\":3}"
                }
                """;

        mockMvc.perform(post("/api/internal/audit-log")
                .contentType(MediaType.APPLICATION_JSON)
                .content(body))
               .andExpect(status().isOk());

        assertThat(auditLogRepository.count()).isEqualTo(countBefore + 1);
    }

    @Test
    void recordAuditLog_checksumIsValid() throws Exception {
        String body = """
                {
                  "actor": "system",
                  "action": "CREDITED",
                  "resourceType": "NftHolding",
                  "resourceId": "0x4b0897b0513fdc7c541b6d9d7e929c4e5364d2db:3003",
                  "beforeState": null,
                  "afterState": "{\\"tokenId\\":3003,\\"amount\\":1}"
                }
                """;

        mockMvc.perform(post("/api/internal/audit-log")
                .contentType(MediaType.APPLICATION_JSON)
                .content(body))
               .andExpect(status().isOk());

        var entries = auditLogRepository
            .findByResourceTypeAndResourceIdOrderByEventTimeAsc(
                "NftHolding", "0x4b0897b0513fdc7c541b6d9d7e929c4e5364d2db:3003");

        assertThat(entries).isNotEmpty();
        Long entryId = entries.get(entries.size() - 1).getId();
        assertThat(auditLogService.verifyIntegrity(entryId)).isTrue();
    }
}
