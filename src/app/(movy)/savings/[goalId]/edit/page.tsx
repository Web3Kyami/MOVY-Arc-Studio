import { CreateGoalView } from '@/components/movy/views/create-goal-view'

export const metadata = { title: 'Edit goal | MOVY' }

export default async function EditGoalPage({ params }: { params: Promise<{ goalId: string }> }) {
  const { goalId } = await params
  return <CreateGoalView goalId={goalId} />
}
