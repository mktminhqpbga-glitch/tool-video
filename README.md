# Affiliate Video Local

Ứng dụng web cục bộ tạo video review từ link Shopee Việt Nam và TikTok Shop. Một sản phẩm có một hồ sơ và một thư mục Drive. Bạn tự đăng bằng video và content trong hồ sơ.

## Chạy lần đầu

1. Chép cả thư mục **affiliate-video** sang máy đang chạy mac2API. Cài [Node.js 24 LTS](https://nodejs.org/) nếu máy chưa có.
2. Mở Terminal tại thư mục đó và chạy `npm start`. App không cần chạy `npm install`.
3. Mở **http://127.0.0.1:8765**. Giữ cửa sổ Terminal và mac2API mở trong lúc xử lý.
4. Trong **Cài đặt**, nhập khóa người dùng mac2API bắt đầu bằng `m2c_`. Địa chỉ mặc định là `http://127.0.0.1:18610/v1`. Lưu rồi bấm **Kiểm tra kết nối đã lưu**. Chọn đúng model văn bản và video mà khóa của bạn có quyền sử dụng.
5. Mở Chrome tại `chrome://extensions`, bật **Chế độ dành cho nhà phát triển**, chọn **Tải tiện ích đã giải nén** và trỏ vào thư mục **extension**. Trong app, sao chép mã kết nối ở **Cài đặt**. Mở tiện ích trên thanh Chrome, dán mã và chọn **Lưu và kiểm tra**. Dùng Chrome có phiên đăng nhập Shopee và TikTok Shop của bạn.
6. Kết nối Drive theo phần bên dưới. Mở **Kho prompt** để sửa mẫu Review sản phẩm hoặc tạo mẫu theo nhóm.

## Kết nối Google Drive

1. Trong [Google Cloud Console](https://console.cloud.google.com/), tạo hoặc chọn dự án và bật **Google Drive API**.
2. Trong phần **Google Auth Platform**, cấu hình màn hình đồng ý. Nếu dự án ở chế độ thử nghiệm, thêm tài khoản Google bạn sẽ dùng vào **Test users**.
3. Tạo **OAuth Client ID** loại **Web application**. Trong **Authorized redirect URIs**, thêm `http://127.0.0.1:8765/oauth/google/callback`.
4. Trong app, vào **Cài đặt → Google Drive**, nhập Client ID, Client Secret và đặt tên thư mục gốc. Bấm **Lưu cấu hình Drive**, rồi **Kết nối Google Drive** và cấp quyền.
5. App dùng quyền `drive.file` và tạo thư mục gốc do app quản lý khi lưu video đầu tiên. Tên trong app được dùng khi tạo thư mục lần đầu. Bạn có thể đổi tên thư mục đã tạo trực tiếp trên Drive. Nếu Drive yêu cầu đăng nhập lại, hãy kết nối lại bằng cùng tài khoản để các thư mục đã tạo vẫn mở được.

## Dùng app

- Dán tối đa 100 dòng link trong mỗi đợt. Xem kết quả từng dòng tại **Tiến độ**. Link trùng mở hồ sơ đã có.
- Nếu Chrome yêu cầu đăng nhập, đăng nhập ở tab app mở, sau đó bấm **Lấy lại**. Nếu trang đổi giao diện và extension chưa đọc được, chọn **Nhập thủ công** với URL sản phẩm trực tiếp.
- Nếu báo **Thiếu ảnh sản phẩm**, mở hồ sơ và tải ảnh thật lên. App tự tiếp tục khi có tên và ảnh hợp lệ.
- Trong **Kho prompt**, bạn có thể tạo nhiều mẫu theo nhóm. Model chọn một nhóm được định nghĩa và dùng mẫu chung nếu chưa tìm thấy nhóm phù hợp.
- Mỗi video có **Chỉnh sâu và tạo video mới**. Bạn có thể sửa, thêm hoặc bỏ từng cảnh trong kịch bản, chọn ảnh chính, thay ảnh nhân vật, ghi đè prompt và chỉnh tỷ lệ, thời lượng, độ phân giải hoặc model.
- Sửa caption, hashtag, lời kêu gọi và link bài đã đăng ngay trên phiên bản video. Thông tin affiliate lưu riêng theo sản phẩm.
- Trong **Báo lỗi**, bấm **Tải báo cáo lỗi** để xuất JSON. Báo cáo có mã lỗi, bước và cách xử lý nếu có. Khóa API, cookie, token OAuth và URL ký tải video không được đưa vào báo cáo.

## Dữ liệu, khôi phục và giới hạn

- App chỉ nghe tại `127.0.0.1:8765`. Thư mục **data** chứa cơ sở dữ liệu cục bộ, ảnh, tệp tạm và cấu hình. Sao lưu thư mục khi app đã dừng. Giữ bản sao riêng vì nó chứa khóa và quyền truy cập tài khoản đã cấu hình.
- App giữ mã tác vụ và khóa chống gửi trùng. Nếu không chắc tác vụ đã được nhận, app tra cứu biên nhận rồi hiện lựa chọn thử lại. Tệp video đã tải về được giữ đến khi lưu Drive thành công.
- Chuẩn không công bố giá được gửi trong chỉ dẫn, dữ liệu văn bản được lọc và kịch bản được kiểm tra theo mẫu nhận diện giá. Phiên bản này chưa nhận dạng chữ trong ảnh hoặc kiểm tra lời thoại, chữ trong MP4 cuối. Hãy xem video trước khi tự đăng.
- Thời lượng, ảnh tham chiếu và độ phân giải thực tế phụ thuộc cấu hình mac2API và nhà cung cấp.
- Nhà cung cấp có thể thay đổi HTML, tên miền CDN hoặc yêu cầu đăng nhập. Hồ sơ hỗ trợ nhập thủ công và bổ sung ảnh cho các trường hợp này.

## Cấu trúc mã nguồn

| Đường dẫn | Công việc |
|---|---|
| `server/index.mjs` | Server loopback, HTTP API, xác thực kết nối extension |
| `server/store.mjs` | Cấu hình mặc định, lưu trạng thái và nhật ký |
| `server/products.mjs` | Kiểm tra link, định danh sản phẩm, nhận ảnh và tạo phiên bản |
| `server/workflow.mjs` | Hàng đợi và chuyển trạng thái từng phiên bản |
| `server/services.mjs` | Các yêu cầu mac2API, tải video và Google OAuth/Drive |
| `web/` | Giao diện tiếng Việt |
| `extension/` | Tiện ích Chrome đọc trang sản phẩm |
| `tests/` | Kiểm tra luồng và phục hồi với dịch vụ mô phỏng |
| `lich-su/` | Nhật ký những gì đã làm và những thay đổi theo phiên bản |

Dừng app đang chạy ở cổng 8765 trước khi kiểm tra bằng `npm test`.
