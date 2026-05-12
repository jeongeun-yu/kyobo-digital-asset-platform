package io.coincraft.kyobo.gateway.repository;

import io.coincraft.kyobo.gateway.entity.AuditLogEntry;
import org.springframework.data.jpa.repository.JpaRepository;
import java.util.List;

public interface AuditLogRepository extends JpaRepository<AuditLogEntry, Long> {
    // 감사 로그는 조회만 — 별도 delete/update 메서드 없음 (의도적)
    List<AuditLogEntry> findByResourceTypeAndResourceIdOrderByEventTimeAsc(
        String resourceType, String resourceId);
}
