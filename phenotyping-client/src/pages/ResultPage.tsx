// ResultPage — top-level wrapper for the result viewer.
// Routes:
//   /analyze/results/:batchId/images/:imageId   (canonical)
//   /analyze/results/:batchId                    (canonicalizes to first image)
//   /analyze/results                             (sessionStorage fallback)

import { ResultViewer } from "@/features/results/components/ResultViewer";

export default function ResultPage() {
  return <ResultViewer />;
}
