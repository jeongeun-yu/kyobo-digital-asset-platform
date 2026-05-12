package io.coincraft.kyobo.gateway.service;

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
import java.util.HexFormat;

/**
 * 감사 로그 서비스 — append-only
 *
 * 이 서비스의 log() 메서드는 INSERT만 수행한다. UPDATE/DELETE 없음.
 * checksum으로 무결성 검증 가능: SHA-256(eventTime + actor + action + resourceId + afterState)
 *
 * 별도 트랜잭션(REQUIRES_NEW): 메인 트랜잭션 롤백 시에도 감사 로그는 보존한다.
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class AuditLogService {

    private final AuditLogRepository auditLogRepository;

    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public void log(String actor, String action, String resourceType,
                    String resourceId, String beforeState, String afterState) {
        String checksum = computeChecksum(Instant.now().toString(), actor, action, resourceId, afterState);
        AuditLogEntry entry = AuditLogEntry.of(actor, action, resourceType, resourceId, beforeState, afterState, checksum);
        auditLogRepository.save(entry);
        log.debug("[Audit] actor={}, action={}, resource={}:{}", actor, action, resourceType, resourceId);
    }

    public void log(io.coincraft.kyobo.gateway.dto.AuditLogRequest request) {
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
                entry.getEventTime().toString(),
                entry.getActor(),
                entry.getAction(),
                entry.getResourceId(),
                entry.getAfterState()
            );
            return expected.equals(entry.getChecksum());
        }).orElse(false);
    }

    private String computeChecksum(String eventTime, String actor, String action,
                                    String resourceId, String afterState) {
        String input = eventTime + actor + action + resourceId + afterState;
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] hash = digest.digest(input.getBytes(StandardCharsets.UTF_8));
            return HexFormat.of().formatHex(hash);
        } catch (NoSuchAlgorithmException e) {
            throw new RuntimeException("SHA-256 not available", e);
        }
    }
}
