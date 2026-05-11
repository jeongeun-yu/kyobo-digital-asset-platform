# STATUS — 교보생명 디지털 자산 플랫폼

## 현재 상태
| 항목 | 내용 |
|---|---|
| 단계 | 교보생명 강의 진행 중 — 5/11 첫날 M1 |
| 교육 시작 | 5/11 (교보생명) — 58시간 |
| 계약 | 공식 확인 대기 중 (웅진씽크빅/교보DTS) |

## 마지막 작업 (2026-05-11)
- S04 PowerShell 가이드 Sepolia 심화 실습 6종 추가 (체인ID·잔액·블록상세·가스·Etherscan)
- Phase 2/3 stub 주석 전면 정비: XRPLAdapter·CircleAdapter·KyoboVASPAdapter·VaspRecoveryService
- CircleAdapter Phase 3 → Phase 2 오기 수정
- KRW1StablecoinAdapter Phase 2 stub 신규 생성 (XRPL IOU / EVM ERC-20 / CBDC 3옵션)
- issuer-service/index.ts Phase 1/2/3 교체 포인트 주석 완비
- 전체 빌드·테스트 379 TC 전부 통과
- TxStateMachineService Phase 1/2/3별 VaspTxClient 변화 주석 추가

## 다음 작업
- [ ] 강의 현장 긴급 대응 (에러·질문·버그 실시간 처리)
- [ ] 이종건 계약서 일정 확인
- [ ] 교보DTS Core Banking API 스펙 협의
