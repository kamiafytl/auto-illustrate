export default function ProductionView() {
  return (
    <section className="knx-page">
      <h2>生产队列</h2>
      <p>施工中，E3 实装。这里会集中管理生成任务、批次状态和生产参数。</p>
      <div className="knx-card" style={{ width: 'auto' }}>
        <h3>规划要点</h3>
        <p>先建立队列视图和任务状态模型，再逐步接入既有生产能力。</p>
      </div>
    </section>
  )
}
