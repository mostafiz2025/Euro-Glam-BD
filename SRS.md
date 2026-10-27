# Software Requirements Specification (SRS)
# Project Name: Euro Glam Bd

## 1. System Architecture & Tech Stack
* **Frontend:** Next.js (React Framework), Tailwind CSS, TypeScript (Optimized for mobile-first UI layout as seen in mockups: Home, Sub-sections, Product View, and Details tabs)
* **Backend:** Next.js API Routes / NestJS (Modular backend architecture)
* **Database & ORM:** PostgreSQL / MongoDB with Prisma ORM
* **AI Integration:** OpenAI API / Claude API (for image analysis and smart recommendations logic)
* **Notification / SMS Gateway:** Twilio or local BD SMS Gateway API (for Expiry/Order SMS)
* **Image & Video Storage:** Cloudinary or AWS S3 (optimized for high-speed delivery of product images and user video reviews)

## 2. Database Schema Design (High-Level)
* **Users Table:** `id`, `name`, `email`, `phone`, `password_hash`, `role` (customer/admin), `created_at`
* **Products Table:** `id`, `name`, `category_id`, `description`, `price`, `discount_price`, `stock_quantity`, `ingredients` (JSON array for conflict checking), `climate_tips`, `images`, `is_new_arrival`, `is_best_seller`, `discount_percentage`, `created_at`
* **Categories Table:** `id`, `name`, `slug`
* **Cart & Cart_Items Table:** `id`, `user_id`, `product_id`, `quantity`
* **Orders Table:** `id`, `user_id`, `total_amount`, `shipping_address`, `status` (pending, shipped, delivered), `created_at`
* **Reviews Table:** `id`, `product_id`, `user_id`, `rating`, `comment`, `video_url`, `is_approved` (Admin moderation), `created_at`
* **User_Skin_Profiles Table:** `id`, `user_id`, `skin_type`, `concerns`, `last_analysis_date`

## 3. Non-Functional Requirements
* **Performance:** High optimization using Next.js Image component; initial page load time under 2 seconds.
* **Security:** Password hashing using `bcrypt`, JWT-based authentication with **Role-Based Access Control (RBAC)** to secure admin routes, and secure handling of user uploads.
* **Scalability:** Modular backend structure to handle growing product databases and real-time AI API requests smoothly.
