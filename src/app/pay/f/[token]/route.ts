// GET /pay/f/<token> — "Pay Full – Free Shipping".
import { handlePay } from '@/lib/pay/handle-pay'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params
  return handlePay(request, token, 'full')
}
