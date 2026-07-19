# CODEX Live Test: Document Anonymizer

Generated: 2026-07-19T16:44:41.924Z
Provider: qwen36-27b

## Environment
- PGAS_PROVIDER=openai
- PGAS_OPENAI_BASE_URL=http://localhost:8000/v1
- PGAS_OPENAI_MODEL=qwen36-27b
- PGAS_MODEL=qwen36-27b
- PGAS_OPENAI_API_KEY=local
- PGAS_OPENAI_TOOL_CHOICE=required
- PGAS_OPENAI_DISABLE_THINKING=1
- PGAS_OPENAI_TEMPERATURE=0.2
- PGAS_ROUND_TIMEOUT_MS=600000

## vLLM Contention
- test1-anonymize-txt: waited_ms=34; final_num_requests_running=0; final_metric_line="vllm:num_requests_running{engine=\"0\",model_name=\"qwen36-27b\"} 0.0"
- test2-anonymize-docx: waited_ms=50189; final_num_requests_running=0; final_metric_line="vllm:num_requests_running{engine=\"0\",model_name=\"qwen36-27b\"} 0.0"
- test3-rehydrate: waited_ms=712081; final_num_requests_running=0; final_metric_line="vllm:num_requests_running{engine=\"0\",model_name=\"qwen36-27b\"} 0.0"
- test4-anonymize-robustness: waited_ms=25047; final_num_requests_running=0; final_metric_line="vllm:num_requests_running{engine=\"0\",model_name=\"qwen36-27b\"} 0.0"

## Results
### 1. ANONYMIZE / TXT: PASS
- final_mode: "complete"
- branch_taken: "ingest->detect_pii"
- extraction_kind: "content_text"
- nonce_in_output: false
- nonce_in_mapping: true
- mapping_entries: 9
- mapping_entries_json: [{"token":"[PERSON_1]","original":"Alice Johnson","type":"PERSON","occurrences":2},{"token":"[EMAIL_1]","original":"alice.johnson.TXTMRS06FPWHVHR4A@example.com","type":"EMAIL","occurrences":1},{"token":"[PHONE_1]","original":"+1-202-555-0173","type":"PHONE","occurrences":1},{"token":"[PERSON_2]","original":"Bob Smith","type":"PERSON","occurrences":2},{"token":"[ORG_1]","original":"Acme Corporation","type":"ORG","occurrences":2},{"token":"[ADDRESS_1]","original":"123 Main Street, Springfield","type":"ADDRESS","occurrences":1},{"token":"[PERSON_3]","original":"Carol Danvers","type":"PERSON","occurrences":1},{"token":"[ID_1]","original":"CASE-TXTMRS06FPWHVHR4A","type":"ID","occurrences":1},{"token":"[DATE_1]","original":"next week","type":"DATE","occurrences":1}]
- reverse_byte_exact: true
- source_text_matches_original: true
- expected_pii_left_in_output: []
- expected_pii_missing_from_mapping: []
- actions: ["begin_work","record_user_note","record_user_note","request_documents","request_documents","request_documents","ingest_documents","ingest_documents","advance_ingest_to_detect_pii","advance_ingest_to_detect_pii","advance_ingest_to_detect_pii","complete_detect_pii","complete_detect_pii","complete_detect_pii","complete_detect_pii","complete_detect_pii","complete_anonymize","complete_anonymize","complete_anonymize","complete_export_anonymized","complete_export_anonymized","complete_export_anonymized","complete_finalize","complete_finalize","complete_finalize"]
- modes: ["intake","ingest","detect_pii","anonymize","export_anonymized","finalize","complete"]
- failed_gates: ["round 4: GKType","round 6: GKType"]
- repair_attempts: 2
- fallbacks: 0
- session_id: "document-anonymizer-1784478086462"
- rounds: 8
- error: undefined

### 2. ANONYMIZE / DOCX: PASS
- final_mode: "complete"
- branch_taken: "ingest->detect_pii"
- extraction_kind: "docx_deflate"
- nonce_in_output: false
- nonce_in_mapping: true
- mapping_entries: 5
- mapping_entries_json: [{"token":"[PERSON_1]","original":"Eve Martinez","type":"PERSON","occurrences":1},{"token":"[EMAIL_1]","original":"eve.martinez.DOCXMRS0CCNY9RIOKL@example.com","type":"EMAIL","occurrences":1},{"token":"[ID_1]","original":"CASE-DOCXMRS0CCNY9RIOKL","type":"ID","occurrences":1},{"token":"[PERSON_2]","original":"Oscar Reed","type":"PERSON","occurrences":1},{"token":"[ORG_1]","original":"Westlake Health Partners","type":"ORG","occurrences":1}]
- reverse_byte_exact: true
- source_text_matches_original: true
- expected_pii_left_in_output: []
- expected_pii_missing_from_mapping: []
- actions: ["begin_work","record_user_note","record_user_note","request_documents","request_documents","request_documents","ingest_documents","ingest_documents","advance_ingest_to_detect_pii","advance_ingest_to_detect_pii","advance_ingest_to_detect_pii","complete_detect_pii","complete_detect_pii","complete_detect_pii","complete_detect_pii","complete_detect_pii","complete_anonymize","complete_anonymize","complete_anonymize","complete_export_anonymized","complete_export_anonymized","complete_export_anonymized","complete_finalize","complete_finalize","complete_finalize"]
- modes: ["intake","ingest","detect_pii","anonymize","export_anonymized","finalize","complete"]
- failed_gates: []
- repair_attempts: 0
- fallbacks: 0
- session_id: "document-anonymizer-1784478412593"
- rounds: 8
- error: undefined

### 3. REHYDRATE: PASS
- final_mode: "complete"
- branch_taken: "ingest->rehydrate"
- extraction_kind: "content_text"
- restored_equals_original: true
- tokens_left: []
- detect_pii_seen: false
- restored_count: 9
- actions: ["begin_work","record_user_note","record_user_note","request_documents","request_documents","request_documents","ingest_documents","ingest_documents","advance_ingest_to_rehydrate","advance_ingest_to_rehydrate","advance_ingest_to_rehydrate","complete_rehydrate","complete_rehydrate","complete_rehydrate","complete_export_restored","complete_export_restored","complete_export_restored","complete_finalize","complete_finalize","complete_finalize"]
- modes: ["intake","ingest","rehydrate","export_restored","finalize","complete"]
- failed_gates: []
- repair_attempts: 0
- fallbacks: 0
- session_id: "document-anonymizer-1784479265527"
- rounds: 7
- error: undefined

### 4. ANONYMIZE / TXT DIFFERENT PII: PASS
- final_mode: "complete"
- branch_taken: "ingest->detect_pii"
- extraction_kind: "content_text"
- nonce_in_output: null
- nonce_in_mapping: null
- mapping_entries: 6
- mapping_entries_json: [{"token":"[PERSON_1]","original":"Nadia Flores","type":"PERSON"},{"token":"[PERSON_2]","original":"Marcus Lee","type":"PERSON"},{"token":"[ORG_1]","original":"Northstar Biologics","type":"ORG"},{"token":"[PHONE_1]","original":"415-555-0198","type":"PHONE"},{"token":"[ADDRESS_1]","original":"740 Market Street, San Francisco, CA 94103","type":"ADDRESS"},{"token":"[DATE_1]","original":"July 19, 2026","type":"DATE"}]
- reverse_byte_exact: true
- source_text_matches_original: true
- expected_pii_left_in_output: []
- expected_pii_missing_from_mapping: []
- actions: ["begin_work","record_user_note","record_user_note","request_documents","request_documents","request_documents","ingest_documents","ingest_documents","advance_ingest_to_detect_pii","advance_ingest_to_detect_pii","advance_ingest_to_detect_pii","complete_detect_pii","complete_detect_pii","complete_detect_pii","complete_detect_pii","complete_detect_pii","complete_anonymize","complete_anonymize","complete_anonymize","record_user_note","record_user_note","complete_export_anonymized","complete_export_anonymized","complete_export_anonymized","complete_finalize","complete_finalize","complete_finalize"]
- modes: ["intake","ingest","detect_pii","anonymize","export_anonymized","finalize","complete"]
- failed_gates: ["round 4: GKType","round 5: GKType"]
- repair_attempts: 2
- fallbacks: 0
- session_id: "document-anonymizer-1784479349901"
- rounds: 8
- error: undefined

## Aborted Diagnostic Run
- session_id: "document-anonymizer-1784476983805"
- counted_in_results: false
- reason: "operator stopped earlier harness after repeated export_anonymized no-progress fallbacks to avoid consuming many more provider rounds"
- mode_at_abort: "export_anonymized"
- observed_rounds: 9
- exact_failure: "GKType: action \"\" not in current mode vocabulary; repair attempts (2) reached repair_bound (2)"
- note: "This happened before the final counted run above. The final counted run restarted from fresh sessions and all four requested tests reached complete."
