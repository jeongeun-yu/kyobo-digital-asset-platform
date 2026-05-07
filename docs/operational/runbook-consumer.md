# Runbook: Consumer 장애 대응

**대상**: DMZ Consumer Group 운영자  
**관련 세션**: S52  
**관련 코드**: `dmz/packages/event-engine/dmz/ConsumerGroupWorker.ts`

---

## 언제 사용하나

- Consumer 프로세스 크래시 알림 수신
- Consumer Lag(미처리 메시지 수) 임계값 초과 알림
- 이벤트 처리 지연 또는 원장 업데이트 지연 감지

---

## 장애 유형별 대응

### 유형 1 — 프로세스 크래시

**증상**: Consumer 프로세스 종료, PM2 재시작 로그  
**원인**: OOM, 코드 예외, OS 신호

```bash
# 상태 확인
pm2 status consumer

# 로그 확인
pm2 logs consumer --lines 100

# 수동 재시작
pm2 restart consumer
```

재시작 후 확인:
- [ ] PEL(Pending Entry List)에 미처리 메시지 자동 재수신됐는가
- [ ] 원장 중복 반영 없는가 (멱등성 체크가 보장함)
- [ ] Lag이 0으로 수렴하고 있는가

```bash
# PEL 잔량 확인
redis-cli XPENDING nft-events:stream consumer-group - + 10
```

---

### 유형 2 — Lag 증가 (처리 속도 저하)

**증상**: `GET /admin/queue/stats` 에서 Lag이 지속 증가  
**원인**: DB 슬로우 쿼리, 외부 API 지연, 단일 Consumer 처리 한계

```bash
# 현재 Lag 확인
GET /admin/queue/stats

# 슬로우 쿼리 확인 (PostgreSQL)
SELECT query, mean_exec_time, calls
FROM pg_stat_statements
ORDER BY mean_exec_time DESC LIMIT 10;

# Consumer 수평 확장
pm2 scale consumer +2
```

원인 파악 우선순위:
1. DB 슬로우 쿼리 → 인덱스 점검
2. VASP API 응답 지연 → [runbook-vasp-sla.md](runbook-vasp-sla.md) 확인
3. 단순 처리량 부족 → Consumer 인스턴스 추가

---

### 유형 3 — 멱등성 실패 반복

**증상**: 동일 메시지가 반복 처리되어 DLQ로 이동  
**원인**: `processed_events` 테이블 UNIQUE 제약 위반 외 예외

```bash
# 반복 실패 메시지 확인
redis-cli XPENDING nft-events:stream consumer-group - + 10

# processed_events 중복 확인
SELECT tx_hash, log_index, COUNT(*)
FROM processed_events
GROUP BY tx_hash, log_index
HAVING COUNT(*) > 1;
```

> 정상적으로는 `ON CONFLICT DO NOTHING`으로 처리되어야 함. DB 제약 누락 의심 시 스키마 점검.

---

### 유형 4 — Redis 연결 끊김

**증상**: Consumer 로그에 Redis connection 오류  
**원인**: Redis 재시작, 네트워크 단절, 메모리 초과

```bash
# Redis 상태 확인
redis-cli ping

# Redis 메모리 확인
redis-cli info memory | grep used_memory_human

# Consumer 재시작 (연결 재수립)
pm2 restart consumer
```

---

## 모니터링 지표

| 지표 | 정상 | 경고 | 위험 |
|---|---|---|---|
| Consumer Lag | < 10건 | 10~100건 | 100건+ |
| 처리 속도 | > 50 msg/s | 10~50 msg/s | < 10 msg/s |
| PEL 크기 | < 5건 | 5~20건 | 20건+ |
| 에러율 | < 1% | 1~5% | 5%+ |

```bash
# 통합 지표 조회
GET /admin/queue/stats
```

---

## 에스컬레이션

| 상황 | 대응 |
|---|---|
| 재시작으로 해결됨 | 로그 기록 후 종료 |
| Lag 100건 이상 지속 | L2(팀 리드) 알림 |
| 원인 불명 + 멱등성 오류 반복 | L3(개발팀) 긴급 호출 |
| Redis 장애 | 인프라팀 에스컬레이션 |
