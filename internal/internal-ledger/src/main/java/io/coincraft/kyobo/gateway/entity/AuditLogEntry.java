package io.coincraft.kyobo.gateway.entity;

import jakarta.persistence.*;
import lombok.*;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;
import java.time.Instant;

/**
 * 감사 로그 — append-only, 절대 UPDATE/DELETE 금지
 *
 * 규제 근거:
 *   - 전자금융감독규정 §34: 접근 기록 1년 이상 보존
 *   - 가상자산이용자보호법 §15: 거래 기록 5년 보존
 *   - ISMS-P 인증 기준: 로그 무결성 보장
 *
 * checksum: SHA-256(eventTime + actor + action + resourceId + afterState)
 * DB 수준 강제: INSERT만 허용하는 Row Level Security 정책 적용
 */
@Entity
@Table(name = "audit_log")
@Getter
@NoArgsConstructor(access = AccessLevel.PROTECTED)
public class AuditLogEntry {

    @Id
    @GeneratedValue(strategy = GenerationType.SEQUENCE, generator = "audit_log_seq")
    @SequenceGenerator(name = "audit_log_seq", sequenceName = "audit_log_seq", allocationSize = 1)
    private Long id;

    @Column(name = "event_time", nullable = false)
    private Instant eventTime;

    @Column(name = "actor", nullable = false, length = 64)
    private String actor;

    @Column(name = "action", nullable = false, length = 64)
    private String action;

    @Column(name = "resource_type", nullable = false, length = 32)
    private String resourceType;

    @Column(name = "resource_id", nullable = false, length = 128)
    private String resourceId;

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "before_state", columnDefinition = "jsonb")
    private String beforeState;

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "after_state", nullable = false, columnDefinition = "jsonb")
    private String afterState;

    @Column(name = "prev_checksum", length = 64)
    private String prevChecksum;

    @Column(name = "checksum", nullable = false, length = 64)
    private String checksum;

    public static AuditLogEntry of(String actor, String action, String resourceType,
                                    String resourceId, String beforeState, String afterState,
                                    String prevChecksum, String checksum, Instant eventTime) {
        AuditLogEntry e = new AuditLogEntry();
        e.eventTime = eventTime;
        e.actor = actor;
        e.action = action;
        e.resourceType = resourceType;
        e.resourceId = resourceId;
        e.beforeState = beforeState;
        e.afterState = afterState;
        e.prevChecksum = prevChecksum;
        e.checksum = checksum;
        return e;
    }
}
