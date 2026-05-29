package io.coincraft.kyobo.gateway.service;

import io.coincraft.kyobo.gateway.dto.AuditLogRequest;
import io.coincraft.kyobo.gateway.entity.AuditLogEntry;
import io.coincraft.kyobo.gateway.repository.AuditLogRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.HexFormat;

/**
 * 감사 로그 서비스 — append-only
 *
 * 이 서비스의 log() 메서드는 INSERT만 수행한다. UPDATE/DELETE 없음.
 *
 * Hash chain 무결성:
 *   checksum = SHA-256(prevChecksum + eventTime + actor + action + resourceId + afterState)
 *   첫 레코드의 prevChecksum = "0000...0" (64자리 genesis 값)
 *   레코드 수정 후 checksum 재계산해도 다음 레코드의 prevChecksum과 불일치 → 탐지 가능
 *
 * 별도 트랜잭션(REQUIRES_NEW): 메인 트랜잭션 롤백 시에도 감사 로그는 보존한다.
 * findLastForUpdate() PESSIMISTIC_WRITE: 동시 삽입 시 체인 순서 보장.
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class AuditLogService {

    private final AuditLogRepository auditLogRepository;

    static final String GENESIS = "0".repeat(64);

    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public void log(String actor, String action, String resourceType,
                    String resourceId, String beforeState, String afterState) {
        // advisory lock으로 직렬화 — SELECT FOR UPDATE LIMIT 1은 빈 테이블에서 잠글 행이 없어 race 발생
        auditLogRepository.acquireChainLock();
        Instant now = Instant.now().truncatedTo(ChronoUnit.MILLIS);
        String prevChecksum = auditLogRepository.findLast()
                .map(AuditLogEntry::getChecksum)
                .orElse(GENESIS);
        String checksum = computeChecksum(prevChecksum, now.toString(), actor, action, resourceId, afterState);
        AuditLogEntry entry = AuditLogEntry.of(actor, action, resourceType, resourceId,
                beforeState, afterState, prevChecksum, checksum, now);
        auditLogRepository.save(entry);
        log.debug("[Audit] actor={}, action={}, resource={}:{}", actor, action, resourceType, resourceId);
    }

    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public void log(AuditLogRequest request) {
        log(request.actor(), request.action(), request.resourceType(),
            request.resourceId(), request.beforeState(), request.afterState());
    }

    /**
     * checksum 무결성 검증
     * 외부 감사 시 DB 레코드의 변조 여부 확인에 사용
     */
    public boolean verifyIntegrity(Long auditLogId) {
        return auditLogRepository.findById(auditLogId).map(entry -> {
            String expected = computeChecksum(
                entry.getPrevChecksum() != null ? entry.getPrevChecksum() : GENESIS,
                entry.getEventTime().toString(),
                entry.getActor(),
                entry.getAction(),
                entry.getResourceId(),
                entry.getAfterState()
            );
            return expected.equals(entry.getChecksum());
        }).orElse(false);
    }

    private String computeChecksum(String prevChecksum, String eventTime, String actor,
                                    String action, String resourceId, String afterState) {
        String input = prevChecksum + eventTime + actor + action + resourceId + afterState;
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] hash = digest.digest(input.getBytes(StandardCharsets.UTF_8));
            return HexFormat.of().formatHex(hash);
        } catch (NoSuchAlgorithmException e) {
            throw new RuntimeException("SHA-256 not available", e);
        }
    }
}
