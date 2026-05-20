package io.coincraft.kyobo.gateway.repository;

import io.coincraft.kyobo.gateway.entity.AuditLogEntry;
import jakarta.persistence.LockModeType;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Query;
import java.util.List;
import java.util.Optional;

public interface AuditLogRepository extends JpaRepository<AuditLogEntry, Long> {
    // 감사 로그는 조회만 — 별도 delete/update 메서드 없음 (의도적)
    List<AuditLogEntry> findByResourceTypeAndResourceIdOrderByEventTimeAsc(
        String resourceType, String resourceId);

    // hash chain — 직전 레코드 잠금 후 조회 (동시 삽입 시 순서 보장)
    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("SELECT e FROM AuditLogEntry e ORDER BY e.id DESC LIMIT 1")
    Optional<AuditLogEntry> findLastForUpdate();
}
