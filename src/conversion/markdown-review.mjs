// Short reading guidance only. report.json retains every original issue and path.
const descriptions={
  unresolved_manifest_item:['연결된 자료 확인','문서 안의 자료 참조를 찾지 못했습니다. 원본에서 해당 자료를 확인하세요.'],
  missing_package_part:['문서 구성 확인','목차에 지정된 구역을 찾지 못했습니다. 원본 파일을 확인하세요.'],
  unlisted_section:['추가 구역 확인','목차에 없는 구역을 뒤에 보존했습니다. 읽는 순서를 확인하세요.'],
  unknown_namespace:['확장 구조 확인','확장 구조의 글자와 속성을 보존했습니다. 의미는 원본과 대조하세요.'],
  unknown_element:['미지원 구조 확인','해석하지 못한 구조의 글자와 속성을 별도로 보존했습니다.'],
  unknown_metadata:['추가 정보 확인','보조 정보의 글자와 속성을 보존했습니다. 실제 의미를 확인하세요.'],
  unknown_attributes:['추가 속성 확인','해석하지 못한 속성을 부록에 보존했습니다. 원본과 대조하세요.'],
  numbering_requires_review:['문단 번호 확인','번호 정의를 보존했습니다. 실제 번호와 글머리표는 원본에서 확인하세요.'],
  dynamic_page_number_requires_review:['쪽 번호 확인','저장된 제어값과 실제 쪽 번호는 다를 수 있습니다. PDF나 원본에서 확인하세요.'],
  alternative_representations:['대체 표현 확인','같은 개체의 조건별 표현을 구분했습니다. 실제 표시되는 가지를 확인하세요.'],
  tracked_changes_present:['변경 추적 확인','삭제된 내용과 삽입된 내용의 경계를 표시했습니다. 최종 적용 상태를 확인하세요.'],
  unbalanced_change_markers:['변경 범위 확인','변경 추적의 시작이나 끝이 맞지 않습니다. 해당 구간은 원본을 확인하세요.'],
  image_ocr_not_performed:['그림 속 내용 확인','그림 파일을 보존했습니다. 그림 속 글자와 시각적 의미는 별도 확인이 필요합니다.'],
  unresolved_image:['그림 연결 확인','그림 참조를 찾지 못했습니다. 원본 파일의 그림을 확인하세요.'],
  external_reference:['외부 연결 확인','외부 주소를 글자로 보존했습니다. 연결된 내용을 자동으로 가져오지 않았습니다.'],
  visual_object_not_interpreted:['도형·개체 확인','개체의 시각적 의미는 원본이나 PDF에서 확인하세요.'],
  supplementary_xml_text:['보충 텍스트 확인','본문 밖의 글자를 부록에 보존했습니다. 위치와 읽는 순서를 확인하세요.'],
  unreferenced_embedded_object:['추가 포함 파일 확인','본문 참조와 연결하지 못한 포함 파일을 보존했습니다.'],
  hwp_import_scope:['HWP 해석 범위 확인','엔진이 읽지 못한 바이너리 내용까지 완전하게 추출됐다고 보장하지 않습니다.'],
  engine_reported_loss:['엔진 손실 보고 확인','엔진이 손실 가능성을 보고했습니다. 원본과 해석본을 대조하세요.'],
  engine_text_comparison_incomplete:['본문 대조 한도 확인','대조를 끝내지 못해 엔진 본문 전체를 추가로 보존했습니다.'],
  engine_text_not_in_xml:['추가 본문 확인','구조 XML과 대응하지 않은 엔진 본문을 별도로 보존했습니다.'],
};

export function summarizeReviewIssues(issues){
  const grouped=new Map();
  for(const issue of issues)grouped.set(issue.code,(grouped.get(issue.code)??0)+1);
  return [...grouped].map(([code,count])=>{
    const [label,description]=descriptions[code]??['추가 확인 항목','세부 위치와 설명은 report.json에서 확인하세요.'];
    return {code,count,label,description};
  });
}
