// ResultPage — top-level wrapper for the unified result viewer.
//
// Routes:
//   /analyze/results/:batchId/images/:imageId   (canonical)
//   /analyze/results/:batchId                    (canonicalizes to first image)
//   /analyze/results                             (sessionStorage fallback)
//
// ResultViewer branches internally on batch.organism_type — egg/neonate use
// the bbox flow; larvae/pupae render LarvaeResultPanel.

import { ResultViewer } from '@/features/results/components/ResultViewer';

export default function ResultPage() {
    return <ResultViewer />;
}
