package io.coincraft.kyobo.gateway;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.web.servlet.MockMvc;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

@SpringBootTest
@AutoConfigureMockMvc
class BlockchainGatewayControllerTest {

    @Autowired
    private MockMvc mockMvc;

    @Test
    void healthCheck_returns200() throws Exception {
        mockMvc.perform(get("/api/internal/health"))
               .andExpect(status().isOk());
    }

    // TODO: Day 10 실습 — 아래 테스트 케이스 직접 구현
    // @Test void recordNftHolding_savesToDb() ...
    // @Test void recordAuditLog_appendsOnly() ...
    // @Test void recordAuditLog_checksumIsValid() ...
}
