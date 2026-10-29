// GET /pay/<token> — "Pay ₹100 Advance" (also /pay/done, Razorpay's callback).
import { handlePay } from '@/lib/pay/handle-pay'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params
  return handlePay(request, token, 'advance')
}
