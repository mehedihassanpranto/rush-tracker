import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { Plus } from 'lucide-react'

import { listMyLimitRequestsFn } from '@/server/limit-requests/limit-request.fns'
import { PageHeader } from '@/components/shared/page-header'
import { MyLimitRequestsTable } from '@/components/client/my-limit-requests-table'
import { RequestLimitDialog } from '@/components/client/request-limit-dialog'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'

export const Route = createFileRoute('/client/limit-requests/')({
  component: MyLimitRequestsPage,
})

function MyLimitRequestsPage() {
  const listRequests = useServerFn(listMyLimitRequestsFn)
  const [requestOpen, setRequestOpen] = useState(false)

  const { data: requests, isLoading } = useQuery({
    queryKey: ['my-limit-requests'],
    queryFn: () => listRequests(),
  })

  return (
    <div>
      <PageHeader
        title="Limit Requests"
        description="Your limit increase requests and their status."
      >
        <Button onClick={() => setRequestOpen(true)}>
          <Plus className="size-4" />
          New request
        </Button>
      </PageHeader>

      <Card className="p-0">
        <MyLimitRequestsTable requests={requests} isLoading={isLoading} />
      </Card>

      <RequestLimitDialog open={requestOpen} onOpenChange={setRequestOpen} />
    </div>
  )
}
