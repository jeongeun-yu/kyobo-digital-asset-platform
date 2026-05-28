package io.coincraft.kyobo.gateway.repository;

import io.coincraft.kyobo.gateway.entity.AuditLogEntry;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import java.util.List;
import java.util.Optional;

public interface AuditLogRepository extends JpaRepository<AuditLogEntry, Long> {
    // 감사 로그는 조회만 — 별도 delete/update 메서드 없음 (의도적)
    List<AuditLogEntry> findByResourceTypeAndResourceIdOrderByEventTimeAsc(
        String resourceType, String resourceId);

    @Query("SELECT e FROM AuditLogEntry e ORDER BY e.id DESC LIMIT 1")
    Optional<AuditLogEntry> findLast();

    // hash chain 직렬화 — advisory lock으로 빈 테이블·동시 삽입 모두 커버
    // SELECT FOR UPDATE LIMIT 1은 빈 테이블에서 잠글 행이 없어 race 발생 → advisory lock으로 대체
    @Query(value = "SELECT pg_advisory_xact_lock(9000000001)", nativeQuery = true)
    void acquireChainLock();
}
