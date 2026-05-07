# Runbook: 배포·롤백 파이프라인 — 무중단 배포와 롤백 판단 기준

**대상**: 배포 담당자, DevOps  
**관련 세션**: S56  
**관련 코드**: `infrastructure/`

---

## 배포 전 체크리스트

- [ ] CI 빌드·테스트 전부 통과 (`npm run test:all`)
- [ ] 스테이징 환경 배포 및 smoke test 완료
- [ ] DB 마이그레이션 스크립트 있으면 롤백 스크립트 함께 준비
- [ ] 배포 시간대 확인 (업무 시간 내 배포 원칙, 긴급 패치 제외)
- [ ] 배포 담당자·모니터링 담당자 온콜 확인

---

## 배포 파이프라인

```
코드 변경 (PR 병합)
    ↓
CI: 빌드 + 단위 테스트 + 통합 테스트
    ↓
스테이징 자동 배포
    ↓ (수동 승인 게이트)
프로덕션 배포
    ↓
헬스체크 확인 (5분간 모니터링)
```

---

## 배포 방법: Blue/Green

```bash
# 현재 활성 환경 확인
GET /health  # 현재 배포 버전 포함

# Blue/Green 전환 (인프라팀 실행)
# 신규 버전(Green) 준비 → 헬스체크 통과 → 트래픽 전환 → Blue 대기
```

> ⚠️ **스마트컨트랙트 배포는 반드시 Blue/Green**  
> 컨트랙트는 롤백 불가. UUPS Proxy upgrade 후 되돌릴 수 없음.  
> 컨트랙트 배포는 [runbook-contract-upgrade.md](runbook-contract-upgrade.md) 참조.

---

## 헬스체크

```bash
# 전체 컴포넌트 상태 확인
GET /health

# 응답 예시
{
  "status": "ok",
  "db": "connected",
  "redis": "connected",
  "vasp": "connected",
  "version": "1.2.3",
  "uptime": 3600
}
```

배포 직후 5분간 모니터링:
- [ ] 헬스체크 `status: ok` 유지
- [ ] 에러율 변화 없음 (`GET /admin/dashboard` 확인)
- [ ] DLQ 급증 없음
- [ ] Consumer Lag 정상

---

## 롤백 판단 기준

배포 후 **5분 내** 다음 중 하나라도 해당하면 즉시 롤백:

| 지표 | 롤백 기준 |
|---|---|
| 에러율 | 배포 전 대비 1% 이상 증가 |
| P99 응답시간 | 배포 전 대비 2배 이상 증가 |
| DLQ 적재 | 배포 직후 급증 (5분 내 10건+) |
| 헬스체크 | `status: error` 지속 |

---

## 롤백 절차 (백엔드)

```bash
# 이전 버전으로 롤백
# (Blue/Green: 트래픽을 Blue로 복귀)
# 인프라팀 실행

# 롤백 후 헬스체크
GET /health

# DB 마이그레이션 롤백 (필요 시)
npm run db:rollback
```

롤백 후 확인:
- [ ] 헬스체크 정상
- [ ] 에러율 정상으로 복귀
- [ ] DLQ 잔량 처리 ([runbook-dlq.md](runbook-dlq.md) 참조)

---

## 컨트랙트 배포 주의사항

> ⚠️ **컨트랙트 롤백 불가**  
> UUPS Proxy upgrade는 프록시 주소를 유지하며 implementation만 교체.  
> 잘못된 implementation 배포 후 되돌리기 불가능.  
> 반드시 [runbook-contract-upgrade.md](runbook-contract-upgrade.md) 절차 준수.

백엔드 롤백으로 대응 가능한 범위 (사전 정의):
- API 응답 형식 변경
- 비즈니스 로직 버그 (컨트랙트 미관여)
- DB 스키마 변경 (롤백 스크립트 있는 경우)
